pragma solidity ^0.4.24;
import "erc-1155/contracts/IERC1155TokenReceiver.sol";
import "openzeppelin-solidity/contracts/ownership/Ownable.sol";
import "@gnosis.pm/util-contracts/contracts/SignedSafeMath.sol";
import "@gnosis.pm/hg-contracts/contracts/PredictionMarketSystem.sol";

contract MarketMaker is Ownable, IERC1155TokenReceiver {
    using SignedSafeMath for int;
    
    /*
     *  Constants
     */    
    uint64 public constant FEE_RANGE = 10**18;

    /*
     *  Events
     */
    event AutomatedMarketMakerFunding(uint funding);
    event AutomatedMarketMakerClosing();
    event FeeWithdrawal(uint fees);
    event OutcomeTokenTrade(address indexed transactor, int[] outcomeTokenAmounts, int outcomeTokenNetCost, uint marketFees);
    
    /*
     *  Storage
     */
    PredictionMarketSystem public pmSystem;
    IERC20 public collateralToken;
    bytes32 public conditionId;

    uint64 public fee;
    uint public funding;
    Stages public stage;
    enum Stages {
        MarketCreated,
        MarketFunded,
        MarketClosed
    }

    /*
     *  Modifiers
     */
    modifier atStage(Stages _stage) {
        // Contract has to be in given stage
        require(stage == _stage);
        _;
    }

    constructor(PredictionMarketSystem _pmSystem, IERC20 _collateralToken, bytes32 _conditionId, uint64 _fee)
        public
    {
        // Validate inputs
        require(address(_pmSystem) != 0 && _fee < FEE_RANGE);
        pmSystem = _pmSystem;
        collateralToken = _collateralToken;
        conditionId = _conditionId;
        fee = _fee;
        stage = Stages.MarketCreated;
    }

    function calcNetCost(int[] outcomeTokenAmounts) public view returns (int netCost);

    /// @dev Allows to fund the market with collateral tokens converting them into outcome tokens
    /// @param _funding Funding amount
    function fund(uint _funding)
        public
        onlyOwner
        atStage(Stages.MarketCreated)
    {
        // Request collateral tokens and allow event contract to transfer them to buy all outcomes
        require(   collateralToken.transferFrom(msg.sender, this, _funding)
                && collateralToken.approve(pmSystem, _funding));

        uint[] memory partition = generateBasicPartition();

        pmSystem.splitPosition(collateralToken, bytes32(0), conditionId, partition, _funding);
        funding = _funding;
        stage = Stages.MarketFunded;
        emit AutomatedMarketMakerFunding(funding);
    }

    /// @dev Allows market owner to close the markets by transferring all remaining outcome tokens to the owner
    function close()
        public
        onlyOwner
        atStage(Stages.MarketFunded)
    {
        uint outcomeSlotCount = pmSystem.getOutcomeSlotCount(conditionId);
        for (uint i = 0; i < outcomeSlotCount; i++) {
            uint positionId = generateBasicPositionId(i);
            pmSystem.safeTransferFrom(this, owner(), positionId, pmSystem.balanceOf(this, positionId), "");
        }
        stage = Stages.MarketClosed;
        emit AutomatedMarketMakerClosing();
    }

    /// @dev Allows market owner to withdraw fees generated by trades
    /// @return Fee amount
    function withdrawFees()
        public
        onlyOwner
        returns (uint fees)
    {
        fees = collateralToken.balanceOf(this);
        // Transfer fees
        require(collateralToken.transfer(owner(), fees));
        emit FeeWithdrawal(fees);
    }

    /// @dev Allows to trade outcome tokens and collateral with the market maker
    /// @param outcomeTokenAmounts Amounts of each outcome token to buy or sell. If positive, will buy this amount of outcome token from the market. If negative, will sell this amount back to the market instead.
    /// @param collateralLimit If positive, this is the limit for the amount of collateral tokens which will be sent to the market to conduct the trade. If negative, this is the minimum amount of collateral tokens which will be received from the market for the trade. If zero, there is no limit.
    /// @return If positive, the amount of collateral sent to the market. If negative, the amount of collateral received from the market. If zero, no collateral was sent or received.
    function trade(int[] outcomeTokenAmounts, int collateralLimit)
        public
        atStage(Stages.MarketFunded)
        returns (int netCost)
    {
        uint outcomeSlotCount = pmSystem.getOutcomeSlotCount(conditionId);
        require(outcomeTokenAmounts.length == outcomeSlotCount);
        uint[] memory partition = generateBasicPartition();

        // Calculate net cost for executing trade
        int outcomeTokenNetCost = calcNetCost(outcomeTokenAmounts);
        int fees;
        if(outcomeTokenNetCost < 0)
            fees = int(calcMarketFee(uint(-outcomeTokenNetCost)));
        else
            fees = int(calcMarketFee(uint(outcomeTokenNetCost)));

        require(fees >= 0);
        netCost = outcomeTokenNetCost.add(fees);

        require(
            (collateralLimit != 0 && netCost <= collateralLimit) ||
            collateralLimit == 0
        );

        if(outcomeTokenNetCost > 0) {
            require(
                collateralToken.transferFrom(msg.sender, this, uint(netCost)) &&
                collateralToken.approve(pmSystem, uint(outcomeTokenNetCost))
            );

            pmSystem.splitPosition(collateralToken, bytes32(0), conditionId, partition, uint(outcomeTokenNetCost));
        }

        for (uint i = 0; i < outcomeSlotCount; i++) {
            if(outcomeTokenAmounts[i] != 0) {
                uint positionId = generateBasicPositionId(i);
                if(outcomeTokenAmounts[i] < 0) {
                    pmSystem.safeTransferFrom(msg.sender, this, positionId, uint(-outcomeTokenAmounts[i]), "");
                } else {
                    pmSystem.safeTransferFrom(this, msg.sender, positionId, uint(outcomeTokenAmounts[i]), "");
                }

            }
        }

        if(outcomeTokenNetCost < 0) {
            // This is safe since
            // 0x8000000000000000000000000000000000000000000000000000000000000000 ==
            // uint(-int(-0x8000000000000000000000000000000000000000000000000000000000000000))
            pmSystem.mergePositions(collateralToken, bytes32(0), conditionId, partition, uint(-outcomeTokenNetCost));
            if(netCost < 0) {
                require(collateralToken.transfer(msg.sender, uint(-netCost)));
            }
        }

        emit OutcomeTokenTrade(msg.sender, outcomeTokenAmounts, outcomeTokenNetCost, uint(fees));
    }

    /// @dev Calculates fee to be paid to market maker
    /// @param outcomeTokenCost Cost for buying outcome tokens
    /// @return Fee for trade
    function calcMarketFee(uint outcomeTokenCost)
        public
        view
        returns (uint)
    {
        return outcomeTokenCost * fee / FEE_RANGE;
    }

    function onERC1155Received(address operator, address /*from*/, uint256 /*id*/, uint256 /*value*/, bytes /*data*/) external returns(bytes4) {
        if (operator == address(this)) {
            return 0xf23a6e61;
        }
        return 0x0;
    }

    function generateBasicPartition()
        private
        view
        returns (uint[] partition)
    {
        partition = new uint[](pmSystem.getOutcomeSlotCount(conditionId));
        for(uint i = 0; i < partition.length; i++) {
            partition[i] = 1 << i;
        }
    }

    function generateBasicPositionId(uint i)
        internal
        view
        returns (uint)
    {
        return uint(keccak256(abi.encodePacked(
            collateralToken,
            keccak256(abi.encodePacked(
                conditionId,
                1 << i)))));
    }
}