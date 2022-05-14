import { winston, compareAddresses, Contract } from "../utils";
import { buildRelayerRefundTree, buildSlowRelayTree, buildPoolRebalanceLeafTree, SpokePool } from "../utils";
import { BigNumber, toBN, convertFromWei, shortenHexString } from "../utils";
import { shortenHexStrings, EMPTY_MERKLE_ROOT } from "../utils";
import { UnfilledDeposit, Deposit, DepositWithBlock, RootBundle, UnfilledDepositsForOriginChain } from "../interfaces";
import { FillWithBlock, PoolRebalanceLeaf, RelayerRefundLeaf, RelayerRefundLeafWithGroup } from "../interfaces";
import { RunningBalances, BigNumberForToken, FillsToRefund, RelayData } from "../interfaces";
import { DataworkerClients } from "./DataworkerClientHelper";
import { SpokePoolClient } from "../clients";
import * as PoolRebalanceUtils from "./PoolRebalanceUtils";
import { getFillsToRefundCountGroupedByRepaymentChain, updateFillsToRefundWithValidFill } from "./FillUtils";
import { getFillsInRange, getRefundInformationFromFill, updateFillsToRefundWithSlowFill } from "./FillUtils";
import { getFillCountGroupedByProp } from "./FillUtils";
import { getBlockRangeForChain } from "./DataworkerUtils";
import { getUnfilledDepositCountGroupedByProp, getDepositCountGroupedByProp } from "./DepositUtils";
import { flattenAndFilterUnfilledDepositsByOriginChain } from "./DepositUtils";
import { updateUnfilledDepositsWithMatchedDeposit, getUniqueDepositsInRange } from "./DepositUtils";

// @notice Constructs roots to submit to HubPool on L1. Fetches all data synchronously from SpokePool/HubPool clients
// so this class assumes that those upstream clients are already updated and have fetched on-chain data from RPC's.
export class Dataworker {
  // eslint-disable-next-line no-useless-constructor
  constructor(
    readonly logger: winston.Logger,
    readonly clients: DataworkerClients,
    readonly chainIdListForBundleEvaluationBlockNumbers: number[],
    readonly maxRefundCountOverride: number = undefined,
    readonly maxL1TokenCountOverride: number = undefined,
    readonly tokenTransferThreshold: BigNumberForToken = {},
    readonly blockRangeEndBlockBuffer: { [chainId: number]: number } = {}
  ) {
    if (
      maxRefundCountOverride !== undefined ||
      maxL1TokenCountOverride !== undefined ||
      Object.keys(tokenTransferThreshold).length > 0 ||
      Object.keys(blockRangeEndBlockBuffer).length > 0
    )
      this.logger.debug({
        at: "Dataworker constructed with overridden config store settings",
        maxRefundCountOverride: this.maxRefundCountOverride,
        maxL1TokenCountOverride: this.maxL1TokenCountOverride,
        tokenTransferThreshold: this.tokenTransferThreshold,
        blockRangeEndBlockBuffer: this.blockRangeEndBlockBuffer,
      });
  }

  // Common data re-formatting logic shared across all data worker public functions.
  // User must pass in spoke pool to search event data against. This allows the user to refund relays and fill deposits
  // on deprecated spoke pools.
  _loadData(
    blockRangesForChains: number[][],
    spokePoolClients: { [chainId: number]: SpokePoolClient }
  ): {
    unfilledDeposits: UnfilledDeposit[];
    fillsToRefund: FillsToRefund;
    allValidFills: FillWithBlock[];
    deposits: DepositWithBlock[];
  } {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (!this.clients.configStoreClient.isUpdated) throw new Error(`ConfigStoreClient not updated`);
    this.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId) => {
      if (!spokePoolClients[chainId]) throw new Error(`Missing spoke pool client for chain ${chainId}`);
    });
    if (blockRangesForChains.length !== this.chainIdListForBundleEvaluationBlockNumbers.length)
      throw new Error(
        `Unexpected block range list length of ${blockRangesForChains.length}, should be ${this.chainIdListForBundleEvaluationBlockNumbers.length}`
      );

    const unfilledDepositsForOriginChain: UnfilledDepositsForOriginChain = {};
    const fillsToRefund: FillsToRefund = {};
    const deposits: DepositWithBlock[] = [];
    const allValidFills: FillWithBlock[] = [];
    const allInvalidFills: FillWithBlock[] = [];

    const allChainIds = Object.keys(this.clients.spokePoolSigners);
    this.logger.debug({
      at: "Dataworker",
      message: `Loading deposit and fill data`,
      chainIds: allChainIds,
      blockRangesForChains,
    });

    for (const originChainId of allChainIds) {
      const originClient = spokePoolClients[originChainId];
      if (!originClient.isUpdated) throw new Error(`origin SpokePoolClient on chain ${originChainId} not updated`);

      // Loop over all other SpokePoolClient's to find deposits whose destination chain is the selected origin chain.
      for (const destinationChainId of allChainIds) {
        if (originChainId === destinationChainId) continue;

        const destinationClient = spokePoolClients[destinationChainId];
        if (!destinationClient.isUpdated)
          throw new Error(`destination SpokePoolClient with chain ID ${destinationChainId} not updated`);

        // Store all deposits in range, for use in constructing a pool rebalance root. Save deposits with
        // their quote time block numbers so we can pull the L1 token counterparts for the quote timestamp.
        // We can safely filter `deposits` by the bundle block range because its only used to decrement running
        // balances in the pool rebalance root. This array is NOT used when matching fills with deposits. For that,
        // we use the wider event search config of the origin client.
        deposits.push(
          ...getUniqueDepositsInRange(
            blockRangesForChains,
            Number(originChainId),
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers,
            originClient,
            deposits
          )
        );

        destinationClient.getFillsWithBlockForOriginChain(Number(originChainId)).forEach((fillWithBlock) => {
          const blockRangeForChain = getBlockRangeForChain(
            blockRangesForChains,
            Number(destinationChainId),
            this.chainIdListForBundleEvaluationBlockNumbers
          );

          // If fill matches with a deposit, then its a valid fill
          const matchedDeposit: Deposit = originClient.getDepositForFill(fillWithBlock);
          if (matchedDeposit) {
            // Fill was validated. Save it under all validated fills list with the block number so we can sort it by
            // time. Note that its important we don't skip fills outside of the block range at this step because
            // we use allValidFills to find the first fill in the entire history associated with a fill in the block
            // range, in order to determine if we already sent a slow fill for it.
            allValidFills.push(fillWithBlock);

            // If fill is outside block range, we can skip it now since we're not going to add a refund for it.
            if (fillWithBlock.blockNumber > blockRangeForChain[1] || fillWithBlock.blockNumber < blockRangeForChain[0])
              return;

            // Now create a copy of fill with block data removed, and use its data to update the fills to refund obj.
            const { blockNumber, transactionIndex, logIndex, ...fill } = fillWithBlock;
            const { chainToSendRefundTo, repaymentToken } = getRefundInformationFromFill(
              fill,
              this.clients.hubPoolClient,
              blockRangesForChains,
              this.chainIdListForBundleEvaluationBlockNumbers
            );
            updateFillsToRefundWithValidFill(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);

            // Save deposit as one that is eligible for a slow fill, since there is a fill
            // for the deposit in this epoch. We save whether this fill is the first fill for the deposit, because
            // if a deposit has its first fill in this block range, then we can send a slow fill payment to complete
            // the deposit.
            updateUnfilledDepositsWithMatchedDeposit(fill, matchedDeposit, unfilledDepositsForOriginChain);

            // For non-slow relays, save refund amount for the recipient of the refund, i.e. the relayer
            // for non-slow relays.
            if (!fill.isSlowRelay)
              updateFillsToRefundWithSlowFill(fillsToRefund, fill, chainToSendRefundTo, repaymentToken);
          } else allInvalidFills.push(fillWithBlock);
        });
      }
    }

    // For each deposit with a matched fill, figure out the unfilled amount that we need to slow relay. We will filter
    // out any deposits that are fully filled.
    const unfilledDeposits = flattenAndFilterUnfilledDepositsByOriginChain(unfilledDepositsForOriginChain);

    const allInvalidFillsInRange = getFillsInRange(
      allInvalidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    const allValidFillsInRange = getFillsInRange(
      allValidFills,
      blockRangesForChains,
      this.chainIdListForBundleEvaluationBlockNumbers
    );
    this.logger.debug({
      at: "Dataworker",
      message: `Finished loading spoke pool data`,
      blockRangesForChains,
      unfilledDepositsByDestinationChain: getUnfilledDepositCountGroupedByProp(unfilledDeposits, "destinationChainId"),
      depositsInRangeByOriginChain: getDepositCountGroupedByProp(deposits, "originChainId"),
      fillsToRefundInRangeByRepaymentChain: getFillsToRefundCountGroupedByRepaymentChain(fillsToRefund),
      allValidFillsByDestinationChain: getFillCountGroupedByProp(allValidFills, "destinationChainId"),
      allValidFillsInRangeByDestinationChain: getFillCountGroupedByProp(allValidFillsInRange, "destinationChainId"),
      allInvalidFillsInRangeByDestinationChain: getFillCountGroupedByProp(allInvalidFillsInRange, "destinationChainId"),
    });

    if (allInvalidFillsInRange.length > 0)
      this.logger.info({
        at: "Dataworker",
        message: `Finished loading spoke pool data and found some invalid fills in range`,
        blockRangesForChains,
        allInvalidFillsInRangeByDestinationChain: getFillCountGroupedByProp(
          allInvalidFillsInRange,
          "destinationChainId"
        ),
      });

    // Remove deposits that have been fully filled from unfilled deposit array
    return { fillsToRefund, deposits, unfilledDeposits, allValidFills };
  }

  buildSlowRelayRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building slow relay root`, blockRangesForChains });

    const { unfilledDeposits } = this._loadData(blockRangesForChains, spokePoolClients);
    const slowRelayLeaves: RelayData[] = unfilledDeposits.map(
      (deposit: UnfilledDeposit): RelayData => ({
        depositor: deposit.deposit.depositor,
        recipient: deposit.deposit.recipient,
        destinationToken: deposit.deposit.destinationToken,
        amount: deposit.deposit.amount,
        originChainId: deposit.deposit.originChainId,
        destinationChainId: deposit.deposit.destinationChainId,
        realizedLpFeePct: deposit.deposit.realizedLpFeePct,
        relayerFeePct: deposit.deposit.relayerFeePct,
        depositId: deposit.deposit.depositId,
      })
    );

    // Sort leaves deterministically so that the same root is always produced from the same _loadData return value.
    // The { Deposit ID, origin chain ID } is guaranteed to be unique so we can sort on them.
    const sortedLeaves = [...slowRelayLeaves].sort((relayA, relayB) => {
      // Note: Smaller ID numbers will come first
      if (relayA.originChainId === relayB.originChainId) return relayA.depositId - relayB.depositId;
      else return relayA.originChainId - relayB.originChainId;
    });

    return {
      leaves: sortedLeaves,
      tree: buildSlowRelayTree(sortedLeaves),
    };
  }

  buildRelayerRefundRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building relayer refund root`, blockRangesForChains });
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    const { fillsToRefund } = this._loadData(blockRangesForChains, spokePoolClients);

    const relayerRefundLeaves: RelayerRefundLeafWithGroup[] = [];

    // We need to construct a pool rebalance root in order to derive `amountToReturn` from `netSendAmount`.
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForChains, spokePoolClients);

    // We'll construct a new leaf for each { repaymentChainId, L2TokenAddress } unique combination.
    Object.keys(fillsToRefund).forEach((repaymentChainId: string) => {
      Object.keys(fillsToRefund[repaymentChainId]).forEach((l2TokenAddress: string) => {
        const refunds = fillsToRefund[repaymentChainId][l2TokenAddress].refunds;
        // We need to sort leaves deterministically so that the same root is always produced from the same _loadData
        // return value, so sort refund addresses by refund amount (descending) and then address (ascending).
        const sortedRefundAddresses = Object.keys(refunds).sort((addressA, addressB) => {
          if (refunds[addressA].gt(refunds[addressB])) return -1;
          if (refunds[addressA].lt(refunds[addressB])) return 1;
          const sortOutput = compareAddresses(addressA, addressB);
          if (sortOutput !== 0) return sortOutput;
          else throw new Error("Unexpected matching address");
        });

        // Create leaf for { repaymentChainId, L2TokenAddress }, split leaves into sub-leaves if there are too many
        // refunds.

        // The `amountToReturn` for a { repaymentChainId, L2TokenAddress} should be set to max(-netSendAmount, 0).
        const amountToReturn = this._getAmountToReturnForRelayerRefundLeaf(
          endBlockForMainnet,
          repaymentChainId,
          l2TokenAddress,
          poolRebalanceRoot.runningBalances
        );
        const maxRefundCount = this.maxRefundCountOverride
          ? this.maxRefundCountOverride
          : this.clients.configStoreClient.getMaxRefundCountForRelayerRefundLeafForBlock(endBlockForMainnet);
        for (let i = 0; i < sortedRefundAddresses.length; i += maxRefundCount)
          relayerRefundLeaves.push({
            groupIndex: i, // Will delete this group index after using it to sort leaves for the same chain ID and
            // L2 token address
            amountToReturn: i === 0 ? amountToReturn : toBN(0),
            chainId: Number(repaymentChainId),
            refundAmounts: sortedRefundAddresses.slice(i, i + maxRefundCount).map((address) => refunds[address]),
            leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
            l2TokenAddress,
            refundAddresses: sortedRefundAddresses.slice(i, i + maxRefundCount),
          });
      });
    });

    // We need to construct a leaf for any pool rebalance leaves with a negative net send amount and NO fills to refund
    // since we need to return tokens from SpokePool to HubPool.
    poolRebalanceRoot.leaves.forEach((leaf) => {
      leaf.netSendAmounts.forEach((netSendAmount, index) => {
        if (netSendAmount.gte(toBN(0))) return;

        const l2TokenCounterpart = this.clients.hubPoolClient.getDestinationTokenForL1TokenDestinationChainId(
          leaf.l1Tokens[index],
          leaf.chainId
        );
        // If we've already seen this leaf, then skip.
        if (
          relayerRefundLeaves.some(
            (relayerRefundLeaf) =>
              relayerRefundLeaf.chainId === leaf.chainId && relayerRefundLeaf.l2TokenAddress === l2TokenCounterpart
          )
        )
          return;

        const amountToReturn = this._getAmountToReturnForRelayerRefundLeaf(
          endBlockForMainnet,
          leaf.chainId.toString(),
          l2TokenCounterpart,
          poolRebalanceRoot.runningBalances
        );
        relayerRefundLeaves.push({
          groupIndex: 0, // Will delete this group index after using it to sort leaves for the same chain ID and
          // L2 token address
          leafId: 0, // Will be updated before inserting into tree when we sort all leaves.
          chainId: leaf.chainId,
          amountToReturn: amountToReturn, // Never 0 since there will only be one leaf for this chain + L2 token combo.
          l2TokenAddress: l2TokenCounterpart,
          refundAddresses: [],
          refundAmounts: [],
        });
      });
    });

    // Sort leaves by chain ID and then L2 token address in ascending order. Assign leaves unique, ascending ID's
    // beginning from 0.
    const indexedLeaves: RelayerRefundLeaf[] = [...relayerRefundLeaves]
      .sort((leafA, leafB) => {
        if (leafA.chainId !== leafB.chainId) {
          return leafA.chainId - leafB.chainId;
        } else if (compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress) !== 0) {
          return compareAddresses(leafA.l2TokenAddress, leafB.l2TokenAddress);
        } else if (leafA.groupIndex !== leafB.groupIndex) return leafA.groupIndex - leafB.groupIndex;
        else throw new Error("Unexpected leaf group indices match");
      })
      .map((leaf: RelayerRefundLeafWithGroup, i: number): RelayerRefundLeaf => {
        delete leaf.groupIndex; // Delete group index now that we've used it to sort leaves for the same
        // { repaymentChain, l2TokenAddress } since it doesn't exist in RelayerRefundLeaf
        return { ...leaf, leafId: i };
      });

    return {
      leaves: indexedLeaves,
      tree: buildRelayerRefundTree(indexedLeaves),
    };
  }

  buildPoolRebalanceRoot(blockRangesForChains: number[][], spokePoolClients: { [chainId: number]: SpokePoolClient }) {
    this.logger.debug({ at: "Dataworker", message: `Building pool rebalance root`, blockRangesForChains });

    const { fillsToRefund, deposits, allValidFills } = this._loadData(blockRangesForChains, spokePoolClients);

    // 1. For each FilledRelay group, identified by { repaymentChainId, L1TokenAddress }, initialize a "running balance"
    // to the total refund amount for that group.
    // 2. Similarly, for each group sum the realized LP fees.
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForChains,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];

    // Running balances are the amount of tokens that we need to send to each SpokePool to pay for all instant and
    // slow relay refunds. They are decreased by the amount of funds already held by the SpokePool. Balances are keyed
    // by the SpokePool's network and L1 token equivalent of the L2 token to refund.
    // Realized LP fees are keyed the same as running balances and represent the amount of LP fees that should be paid
    // to LP's for each running balance.
    const { runningBalances, realizedLpFees } = PoolRebalanceUtils.initializeRunningBalancesFromRelayerRepayments(
      endBlockForMainnet,
      this.clients.hubPoolClient,
      fillsToRefund
    );

    // For certain fills associated with another partial fill from a previous root bundle, we need to adjust running
    // balances because the prior partial fill would have triggered a refund to be sent to the spoke pool to refund
    // a slow fill.
    PoolRebalanceUtils.subtractExcessFromPreviousSlowFillsFromRunningBalances(
      runningBalances,
      this.clients.hubPoolClient,
      allValidFills,
      this.chainIdListForBundleEvaluationBlockNumbers
    );

    // 5. Map each deposit event to its L1 token and origin chain ID and subtract deposited amounts from running
    // balances. Note that we do not care if the deposit is matched with a fill for this epoch or not since all
    // deposit events lock funds in the spoke pool and should decrease running balances accordingly. However,
    // its important that `deposits` are all in this current block range.
    deposits.forEach((deposit: DepositWithBlock) => {
      PoolRebalanceUtils.updateRunningBalanceForDeposit(
        runningBalances,
        this.clients.hubPoolClient,
        deposit,
        deposit.amount.mul(toBN(-1))
      );
    });

    const leaves: PoolRebalanceLeaf[] = PoolRebalanceUtils.constructPoolRebalanceLeaves(
      endBlockForMainnet,
      runningBalances,
      realizedLpFees,
      this.clients.configStoreClient,
      this.maxL1TokenCountOverride,
      this.tokenTransferThreshold
    );

    return {
      runningBalances,
      realizedLpFees,
      leaves,
      tree: buildPoolRebalanceLeafTree(leaves),
    };
  }

  async proposeRootBundle() {
    // TODO: Handle the case where we can't get event data or even blockchain data from any chain. This will require
    // some changes to override the bundle block range here, and _loadData to skip chains with zero block ranges.
    // For now, we assume that if one blockchain fails to return data, then this entire function will fail. This is a
    // safe strategy but could lead to new roots failing to be proposed until ALL networks are healthy.

    // 0. Check if a bundle is pending.
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    if (this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "Has pending proposal, cannot propose",
      });
      return;
    }

    // 1. Construct a list of ending block ranges for each chain that we want to include
    // relay events for. The ending block numbers for these ranges will be added to a "bundleEvaluationBlockNumbers"
    // list, and the order of chain ID's is hardcoded in the ConfigStore client.
    const blockRangesForProposal = await this._getWidestPossibleExpectedBlockRange();

    // 2. Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesForProposal,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    this.logger.debug({
      at: "Dataworker#propose",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await this._constructSpokePoolClientsForBlockAndUpdate(endBlockForMainnet);

    // 3. Create roots
    const poolRebalanceRoot = this.buildPoolRebalanceRoot(blockRangesForProposal, spokePoolClients);
    poolRebalanceRoot.leaves.forEach((leaf: PoolRebalanceLeaf, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is list of BN's. For this leaf, there are no BN's not in lists.
        if (BigNumber.isBigNumber(leaf[key][0])) result[key] = leaf[key].map((val) => val.toString());
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker#propose",
        message: `Pool rebalance leaf #${index}`,
        prettyLeaf,
        proof: poolRebalanceRoot.tree.getHexProof(leaf),
      });
      return prettyLeaf;
    });
    const relayerRefundRoot = this.buildRelayerRefundRoot(blockRangesForProposal, spokePoolClients);
    relayerRefundRoot.leaves.forEach((leaf: RelayerRefundLeaf, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is list of BN's or single BN.
        if (Array.isArray(leaf[key]) && BigNumber.isBigNumber(leaf[key][0]))
          result[key] = leaf[key].map((val) => val.toString());
        else if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker#propose",
        message: `Relayer refund leaf #${index}`,
        leaf: prettyLeaf,
        proof: relayerRefundRoot.tree.getHexProof(leaf),
      });
    });
    const slowRelayRoot = this.buildSlowRelayRoot(blockRangesForProposal, spokePoolClients);
    slowRelayRoot.leaves.forEach((leaf: RelayData, index) => {
      const prettyLeaf = Object.keys(leaf).reduce((result, key) => {
        // Check if leaf value is BN.
        if (BigNumber.isBigNumber(leaf[key])) result[key] = leaf[key].toString();
        else result[key] = leaf[key];
        return result;
      }, {});
      this.logger.debug({
        at: "Dataworker#propose",
        message: `Slow relay leaf #${index}`,
        leaf: prettyLeaf,
        proof: slowRelayRoot.tree.getHexProof(leaf),
      });
    });

    if (poolRebalanceRoot.leaves.length === 0) {
      this.logger.debug({
        at: "Dataworker#propose",
        message: "No pool rebalance leaves, cannot propose",
      });
      return;
    }

    // 4. Propose roots to HubPool contract.
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;
    this.logger.debug({
      at: "Dataworker#propose",
      message: "Enqueing new root bundle proposal txn",
      blockRangesForProposal,
      poolRebalanceLeavesCount: poolRebalanceRoot.leaves.length,
      poolRebalanceRoot: poolRebalanceRoot.tree.getHexRoot(),
      relayerRefundRoot: relayerRefundRoot.tree.getHexRoot(),
      slowRelayRoot: slowRelayRoot.tree.getHexRoot(),
    });
    this._proposeRootBundle(
      hubPoolChainId,
      blockRangesForProposal,
      poolRebalanceRoot.leaves,
      poolRebalanceRoot.tree.getHexRoot(),
      relayerRefundRoot.leaves,
      relayerRefundRoot.tree.getHexRoot(),
      slowRelayRoot.leaves,
      slowRelayRoot.tree.getHexRoot()
    );
  }

  async validateRootBundle() {
    if (!this.clients.hubPoolClient.isUpdated) throw new Error(`HubPoolClient not updated`);
    const hubPoolChainId = (await this.clients.hubPoolClient.hubPool.provider.getNetwork()).chainId;

    // Exit early if a bundle is pending.
    if (!this.clients.hubPoolClient.hasPendingProposal()) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "No pending proposal, nothing to validate",
      });
      return;
    }

    const pendingRootBundle = this.clients.hubPoolClient.getPendingRootBundleProposal();
    this.logger.debug({
      at: "Dataworker#validate",
      message: "Found pending proposal",
      pendingRootBundle,
    });

    // Exit early if challenge period timestamp has passed:
    if (this.clients.hubPoolClient.currentTime > pendingRootBundle.challengePeriodEndTimestamp) {
      this.logger.debug({
        at: "Dataworke#validater",
        message: "Challenge period passed, cannot dispute",
      });
      return;
    }

    // If pool rebalance root is empty, always dispute. There should never be a bundle with an empty rebalance root.
    if (pendingRootBundle.poolRebalanceRoot === EMPTY_MERKLE_ROOT) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Empty pool rebalance root, submitting dispute",
        pendingRootBundle,
      });
      this._submitDisputeWithMrkdwn(hubPoolChainId, `Disputed pending root bundle with empty pool rebalance root`);
      return;
    }

    // First, we'll evaluate the pending root bundle's block end numbers.
    const widestPossibleExpectedBlockRange = await this._getWidestPossibleExpectedBlockRange();
    if (pendingRootBundle.bundleEvaluationBlockNumbers.length !== widestPossibleExpectedBlockRange.length) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected bundle block range length, disputing",
        widestPossibleExpectedBlockRange,
        pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
      });
      this._submitDisputeWithMrkdwn(
        hubPoolChainId,
        `Disputed pending root bundle with incorrect bundle block range length`
      );
      return;
    }

    // These buffers can be configured by the bot runner. These are used to validate the end blocks specified in the
    // pending root bundle. If the end block is greater than the latest block for its chain, then we should dispute the
    // bundle because we can't look up events in the future for that chain. However, there are some cases where the
    // proposer's node for that chain is returning a higher HEAD block than the bot-runner is seeing, so we can
    // use this buffer to allow the proposer some margin of error. If the bundle end block is less than HEAD but within
    // this buffer, then we won't dispute and we'll just exit early from this function.
    const endBlockBuffers = this.chainIdListForBundleEvaluationBlockNumbers.map(
      (chainId: number) => this.blockRangeEndBlockBuffer[chainId] ?? 0
    );

    // Make sure that all end blocks are >= expected start blocks.
    if (
      pendingRootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block < widestPossibleExpectedBlockRange[index][0]
      )
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "A bundle end block is < expected start block, submitting dispute",
        expectedStartBlocks: widestPossibleExpectedBlockRange.map((range) => range[0]),
        pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
      });
      this._submitDisputeWithMrkdwn(
        hubPoolChainId,
        this._generateMarkdownForDisputeInvalidBundleBlocks(
          pendingRootBundle,
          widestPossibleExpectedBlockRange,
          endBlockBuffers
        )
      );
      return;
    }

    // If the bundle end block is less than HEAD but within the allowable margin of error into future,
    // then we won't dispute and we'll just exit early from this function.
    if (
      pendingRootBundle.bundleEvaluationBlockNumbers.some(
        (block, index) => block > widestPossibleExpectedBlockRange[index][1]
      )
    ) {
      // If end block is further than the allowable margin of error into the future, then dispute it.
      if (
        pendingRootBundle.bundleEvaluationBlockNumbers.some(
          (block, index) => block > widestPossibleExpectedBlockRange[index][1] + endBlockBuffers[index]
        )
      ) {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "A bundle end block is > latest block + buffer for its chain, submitting dispute",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
        this._submitDisputeWithMrkdwn(
          hubPoolChainId,
          this._generateMarkdownForDisputeInvalidBundleBlocks(
            pendingRootBundle,
            widestPossibleExpectedBlockRange,
            endBlockBuffers
          )
        );
      } else {
        this.logger.debug({
          at: "Dataworker#validate",
          message: "A bundle end block is > latest block but within buffer, skipping",
          expectedEndBlocks: widestPossibleExpectedBlockRange.map((range) => range[1]),
          pendingEndBlocks: pendingRootBundle.bundleEvaluationBlockNumbers,
          endBlockBuffers,
        });
      }
      return;
    }

    // The block range that we'll use to construct roots will be the end block specified in the pending root bundle,
    // and the block right after the last valid root bundle proposal's end block. If the proposer didn't use the same
    // start block, then they might have missed events and the roots will be different.
    const blockRangesImpliedByBundleEndBlocks = widestPossibleExpectedBlockRange.map((blockRange, index) => [
      blockRange[0],
      pendingRootBundle.bundleEvaluationBlockNumbers[index],
    ]);

    this.logger.debug({
      at: "Dataworker#validate",
      message: "Implied bundle ranges are valid",
      blockRangesImpliedByBundleEndBlocks,
      chainIdListForBundleEvaluationBlockNumbers: this.chainIdListForBundleEvaluationBlockNumbers,
    });

    // Construct spoke pool clients using spoke pools deployed at end of block range.
    // We do make an assumption that the spoke pool contract was not changed during the block range. By using the
    // spoke pool at this block instead of assuming its the currently deployed one, we can pay refunds for deposits
    // on deprecated spoke pools.
    const endBlockForMainnet = getBlockRangeForChain(
      blockRangesImpliedByBundleEndBlocks,
      1,
      this.chainIdListForBundleEvaluationBlockNumbers
    )[1];
    this.logger.debug({
      at: "Dataworker#validate",
      message: `Constructing spoke pool clients for end mainnet block in bundle range`,
      endBlockForMainnet,
    });
    const spokePoolClients = await this._constructSpokePoolClientsForBlockAndUpdate(endBlockForMainnet);

    // Compare roots with expected. The roots will be different if the block range start blocks were different
    // than the ones we constructed above when the original proposer submitted their proposal. The roots will also
    // be different if the events on any of the contracts were different.
    const expectedPoolRebalanceRoot = this.buildPoolRebalanceRoot(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const expectedRelayerRefundRoot = this.buildRelayerRefundRoot(
      blockRangesImpliedByBundleEndBlocks,
      spokePoolClients
    );
    const expectedSlowRelayRoot = this.buildSlowRelayRoot(blockRangesImpliedByBundleEndBlocks, spokePoolClients);
    if (
      expectedPoolRebalanceRoot.leaves.length !== pendingRootBundle.unclaimedPoolRebalanceLeafCount ||
      expectedPoolRebalanceRoot.tree.getHexRoot() !== pendingRootBundle.poolRebalanceRoot
    ) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected pool rebalance root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedPoolRebalanceLeaves: expectedPoolRebalanceRoot.leaves,
        expectedPoolRebalanceRoot: expectedPoolRebalanceRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.poolRebalanceRoot,
        pendingPoolRebalanceLeafCount: pendingRootBundle.unclaimedPoolRebalanceLeafCount,
      });
    } else if (expectedRelayerRefundRoot.tree.getHexRoot() !== pendingRootBundle.relayerRefundRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected relayer refund root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedRelayerRefundRoot: expectedRelayerRefundRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.relayerRefundRoot,
      });
    } else if (expectedSlowRelayRoot.tree.getHexRoot() !== pendingRootBundle.slowRelayRoot) {
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Unexpected slow relay root, submitting dispute",
        expectedBlockRanges: blockRangesImpliedByBundleEndBlocks,
        expectedSlowRelayRoot: expectedSlowRelayRoot.tree.getHexRoot(),
        pendingRoot: pendingRootBundle.slowRelayRoot,
      });
    } else {
      // All roots are valid! Exit early.
      this.logger.debug({
        at: "Dataworker#validate",
        message: "Pending root bundle matches with expected",
      });
      return;
    }

    this._submitDisputeWithMrkdwn(
      hubPoolChainId,
      this._generateMarkdownForDispute(pendingRootBundle) +
        `\n` +
        this._generateMarkdownForRootBundle(
          hubPoolChainId,
          blockRangesImpliedByBundleEndBlocks,
          [...expectedPoolRebalanceRoot.leaves],
          expectedPoolRebalanceRoot.tree.getHexRoot(),
          [...expectedRelayerRefundRoot.leaves],
          expectedRelayerRefundRoot.tree.getHexRoot(),
          [...expectedSlowRelayRoot.leaves],
          expectedSlowRelayRoot.tree.getHexRoot()
        )
    );
  }

  // This returns a possible next block range that could be submitted as a new root bundle, or used as a reference
  // when evaluating  pending root bundle. The block end numbers must be less than the latest blocks for each chain ID
  // (because we can't evaluate events in the future), and greater than the the expected start blocks, which are the
  // greater of 0 and the latest bundle end block for an executed root bundle proposal + 1.
  async _getWidestPossibleExpectedBlockRange(): Promise<number[][]> {
    const latestBlockNumbers = await Promise.all(
      this.chainIdListForBundleEvaluationBlockNumbers.map((chainId: number) =>
        this.clients.spokePoolSigners[chainId].provider.getBlockNumber()
      )
    );
    return this.chainIdListForBundleEvaluationBlockNumbers.map((chainId: number, index) => [
      this.clients.hubPoolClient.getNextBundleStartBlockNumber(
        this.chainIdListForBundleEvaluationBlockNumbers,
        this.clients.hubPoolClient.latestBlockNumber,
        chainId
      ),
      latestBlockNumbers[index],
    ]);
  }

  async executeSlowRelayLeaves() {
    // TODO: Caller should grab `bundleBlockNumbers` from ProposeRootBundle event, recreate root and execute
    // all leaves for root. To locate `rootBundleId`, look up `SpokePool.RelayedRootBundle` events and find event
    // with matching roots.
  }

  async executePoolRebalanceLeaves() {
    // TODO:
  }

  async executeRelayerRefundLeaves() {
    // TODO:
  }

  _proposeRootBundle(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: any[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: any[],
    relayerRefundRoot: string,
    slowRelayLeaves: any[],
    slowRelayRoot: string
  ) {
    try {
      const bundleEndBlocks = bundleBlockRange.map((block) => block[1]);
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "proposeRootBundle", // method called.
        args: [bundleEndBlocks, poolRebalanceLeaves.length, poolRebalanceRoot, relayerRefundRoot, slowRelayRoot], // props sent with function call.
        message: "Proposed new root bundle 🌱", // message sent to logger.
        mrkdwn: this._generateMarkdownForRootBundle(
          hubPoolChainId,
          bundleBlockRange,
          [...poolRebalanceLeaves],
          poolRebalanceRoot,
          [...relayerRefundLeaves],
          relayerRefundRoot,
          [...slowRelayLeaves],
          slowRelayRoot
        ),
      });
    } catch (error) {
      this.logger.error({ at: "Dataworker", message: "Error creating proposeRootBundleTx", error });
    }
  }

  _submitDisputeWithMrkdwn(hubPoolChainId: number, mrkdwn: string) {
    try {
      this.clients.multiCallerClient.enqueueTransaction({
        contract: this.clients.hubPoolClient.hubPool, // target contract
        chainId: hubPoolChainId,
        method: "disputeRootBundle", // method called.
        args: [], // props sent with function call.
        message: "Disputed pending root bundle 👺", // message sent to logger.
        mrkdwn,
      });
    } catch (error) {
      this.logger.error({ at: "Dataworker", message: "Error creating disputeRootBundleTx", error });
    }
  }

  _generateMarkdownForRootBundle(
    hubPoolChainId: number,
    bundleBlockRange: number[][],
    poolRebalanceLeaves: any[],
    poolRebalanceRoot: string,
    relayerRefundLeaves: any[],
    relayerRefundRoot: string,
    slowRelayLeaves: any[],
    slowRelayRoot: string
  ): string {
    // Create helpful logs to send to slack transport
    let bundleBlockRangePretty = "";
    this.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
      bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(bundleBlockRange[index])}`;
    });

    const convertTokenListFromWei = (chainId: number, tokenAddresses: string[], weiVals: string[]) => {
      return tokenAddresses.map((token, index) => {
        const { decimals } = this.clients.hubPoolClient.getTokenInfo(chainId, token);
        return convertFromWei(weiVals[index], decimals);
      });
    };
    const convertTokenAddressToSymbol = (chainId: number, tokenAddress: string) => {
      return this.clients.hubPoolClient.getTokenInfo(chainId, tokenAddress).symbol;
    };
    const convertL1TokenAddressesToSymbols = (l1Tokens: string[]) => {
      return l1Tokens.map((l1Token) => {
        return convertTokenAddressToSymbol(hubPoolChainId, l1Token);
      });
    };
    let poolRebalanceLeavesPretty = "";
    poolRebalanceLeaves.forEach((leaf, index) => {
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.groupId = leaf.groupIndex;
      delete leaf.groupIndex;
      leaf.bundleLpFees = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.bundleLpFees);
      leaf.runningBalances = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.runningBalances);
      leaf.netSendAmounts = convertTokenListFromWei(hubPoolChainId, leaf.l1Tokens, leaf.netSendAmounts);
      leaf.l1Tokens = convertL1TokenAddressesToSymbols(leaf.l1Tokens);
      poolRebalanceLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });

    let relayerRefundLeavesPretty = "";
    relayerRefundLeaves.forEach((leaf, index) => {
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.amountToReturn = convertFromWei(
        leaf.amountToReturn,
        this.clients.hubPoolClient.getTokenInfo(leaf.chainId, leaf.l2TokenAddress).decimals
      );
      leaf.refundAmounts = convertTokenListFromWei(
        leaf.chainId,
        Array(leaf.refundAmounts.length).fill(leaf.l2TokenAddress),
        leaf.refundAmounts
      );
      leaf.l2Token = convertTokenAddressToSymbol(leaf.chainId, leaf.l2TokenAddress);
      delete leaf.l2TokenAddress;
      leaf.refundAddresses = shortenHexStrings(leaf.refundAddresses);
      relayerRefundLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });

    let slowRelayLeavesPretty = "";
    slowRelayLeaves.forEach((leaf, index) => {
      const decimalsForDestToken = this.clients.hubPoolClient.getTokenInfo(
        leaf.destinationChainId,
        leaf.destinationToken
      ).decimals;
      // Shorten keys for ease of reading from Slack.
      delete leaf.leafId;
      leaf.originChain = leaf.originChainId;
      leaf.destinationChain = leaf.destinationChainId;
      leaf.depositor = shortenHexString(leaf.depositor);
      leaf.recipient = shortenHexString(leaf.recipient);
      leaf.destToken = convertTokenAddressToSymbol(leaf.destinationChainId, leaf.destinationToken);
      leaf.amount = convertFromWei(leaf.amount, decimalsForDestToken);
      leaf.realizedLpFee = `${convertFromWei(leaf.realizedLpFeePct, decimalsForDestToken)}%`;
      leaf.relayerFee = `${convertFromWei(leaf.relayerFeePct, decimalsForDestToken)}%`;
      delete leaf.destinationToken;
      delete leaf.realizedLpFeePct;
      delete leaf.relayerFeePct;
      delete leaf.originChainId;
      delete leaf.destinationChainId;
      slowRelayLeavesPretty += `\n\t\t\t${index}: ${JSON.stringify(leaf)}`;
    });
    return (
      `\n\t*Bundle blocks*:${bundleBlockRangePretty}` +
      `\n\t*PoolRebalance*:\n\t\troot:${shortenHexString(
        poolRebalanceRoot
      )}...\n\t\tleaves:${poolRebalanceLeavesPretty}` +
      `\n\t*RelayerRefund*\n\t\troot:${shortenHexString(
        relayerRefundRoot
      )}...\n\t\tleaves:${relayerRefundLeavesPretty}` +
      `\n\t*SlowRelay*\n\troot:${shortenHexString(slowRelayRoot)}...\n\t\tleaves:${slowRelayLeavesPretty}`
    );
  }

  _generateMarkdownForDispute(pendingRootBundle: RootBundle) {
    return (
      `Disputed pending root bundle:` +
      `\n\tPoolRebalance leaf count: ${pendingRootBundle.unclaimedPoolRebalanceLeafCount}` +
      `\n\tPoolRebalance root: ${shortenHexString(pendingRootBundle.poolRebalanceRoot)}` +
      `\n\tRelayerRefund root: ${shortenHexString(pendingRootBundle.relayerRefundRoot)}` +
      `\n\tSlowRelay root: ${shortenHexString(pendingRootBundle.slowRelayRoot)}` +
      `\n\tProposer: ${shortenHexString(pendingRootBundle.proposer)}`
    );
  }

  _generateMarkdownForDisputeInvalidBundleBlocks(
    pendingRootBundle: RootBundle,
    widestExpectedBlockRange: number[][],
    buffers: number[]
  ) {
    const getBlockRangePretty = (blockRange: number[][] | number[]) => {
      let bundleBlockRangePretty = "";
      this.chainIdListForBundleEvaluationBlockNumbers.forEach((chainId, index) => {
        bundleBlockRangePretty += `\n\t\t${chainId}: ${JSON.stringify(blockRange[index])}`;
      });
      return bundleBlockRangePretty;
    };
    return (
      `Disputed pending root bundle because of invalid bundle blocks:` +
      `\n\t*Widest possible expected block range*:${getBlockRangePretty(widestExpectedBlockRange)}` +
      `\n\t*Buffers to end blocks*:${getBlockRangePretty(buffers)}` +
      `\n\t*Pending end blocks*:${getBlockRangePretty(pendingRootBundle.bundleEvaluationBlockNumbers)}`
    );
  }

  _getAmountToReturnForRelayerRefundLeaf(
    endBlockForMainnet: number,
    leafChainId: string,
    leafToken: string,
    poolRebalanceRunningBalances: RunningBalances
  ) {
    const l1TokenCounterpart = this.clients.hubPoolClient.getL1TokenCounterpartAtBlock(
      leafChainId,
      leafToken,
      endBlockForMainnet
    );
    const runningBalanceForLeaf = poolRebalanceRunningBalances[leafChainId][l1TokenCounterpart];
    const transferThreshold =
      this.tokenTransferThreshold[l1TokenCounterpart] ||
      this.clients.configStoreClient.getTokenTransferThresholdForBlock(l1TokenCounterpart, endBlockForMainnet);

    const netSendAmountForLeaf = PoolRebalanceUtils.getNetSendAmountForL1Token(
      transferThreshold,
      runningBalanceForLeaf
    );
    return netSendAmountForLeaf.mul(toBN(-1)).gt(toBN(0)) ? netSendAmountForLeaf.mul(toBN(-1)) : toBN(0);
  }

  async _constructSpokePoolClientsForBlockAndUpdate(
    latestMainnetBlock: number
  ): Promise<{ [chainId: number]: SpokePoolClient }> {
    const spokePoolClients = Object.fromEntries(
      this.chainIdListForBundleEvaluationBlockNumbers.map((chainId) => {
        const spokePoolContract = new Contract(
          this.clients.hubPoolClient.getSpokePoolForBlock(latestMainnetBlock, Number(chainId)),
          SpokePool.abi,
          this.clients.spokePoolSigners[chainId]
        );
        const client = new SpokePoolClient(
          this.logger,
          spokePoolContract,
          this.clients.configStoreClient,
          Number(chainId),
          this.clients.spokePoolClientSearchSettings[chainId],
          // TODO: This won't always work if the spoke pool is updated, but it will reduce the block range to search
          // deposit route events on.
          this.clients.spokePoolClientSearchSettings[chainId].fromBlock
        );
        return [chainId, client];
      })
    );
    await Promise.all(Object.values(spokePoolClients).map((client: SpokePoolClient) => client.update()));
    return spokePoolClients;
  }
}
