// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ERC20 interface — avoids pulling in OpenZeppelin for the MVP.
/// If the deployment token has non-standard return-value behavior, swap this
/// for OZ's SafeERC20 before mainnet/testnet-with-real-value use.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title AgentTreasury
/// @notice Holds funds on behalf of autonomous AI agents and enforces a spend
///         policy (daily cap + counterparty allowlist) before any value moves.
///
/// @dev Design notes (read before changing behavior):
///
/// 1. AGENT IDENTITY = the agent's own EOA/smart-wallet address.
///    An agent authorizes its own spend by calling `spend()` from its own
///    address. This is deliberate: the point of AgentVault is that the agent
///    itself holds the key and acts autonomously — a human or the backend
///    should never be the one calling spend() on an agent's behalf.
///
/// 2. COUNTERPARTIES ARE bytes32 IDS, NOT ADDRESSES.
///    A "counterparty" here is whatever the agent is paying — an API
///    provider, a data vendor, another agent — and it may not have any
///    presence on this chain at all. Moove resolves the actual cross-chain /
///    cross-token delivery off-chain. So the allowlist stores
///    keccak256(counterpartyIdentifier) (e.g. hash of a Moove Handle or a
///    provider's registered service ID) rather than an on-chain address.
///
/// 3. THIS CONTRACT DOES NOT TALK TO MOOVE DIRECTLY.
///    spend() moves funds from the agent's internal balance to a single
///    `settlementRelayer` address controlled by the AgentVault backend. The
///    backend watches for the SpendExecuted event and then calls Moove's
///    API to actually deliver value to the real counterparty. The contract's
///    job is authorization + custody + audit trail, not cross-chain routing.
///
/// 4. REPLAY PROTECTION.
///    Callers (agent or backend, depending on integration) supply a
///    `requestId`. Once used, it can never be used again — this makes the
///    backend's retry logic idempotent-safe against double execution.
///
/// 5. DAILY CAP.
///    Rolling window bucketed by `block.timestamp / 1 days`. Slight boundary
///    imprecision (UTC day, not a true 24h rolling window) is an accepted
///    MVP tradeoff — flagged here rather than silently shipped.
contract AgentTreasury {
    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;
    address public settlementRelayer;
    IERC20 public immutable token;
    bool public paused;

    struct Policy {
        uint256 dailyCap;
        bool exists;
    }

    mapping(address => Policy) public policies;                     // agent => policy
    mapping(address => mapping(bytes32 => bool)) public allowedCounterparty; // agent => counterpartyId => allowed
    mapping(address => uint256) public balances;                    // agent => available balance
    mapping(address => mapping(uint256 => uint256)) public spentOnDay; // agent => day => amount spent
    mapping(bytes32 => bool) public usedRequestIds;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(address indexed agent, address indexed from, uint256 amount);
    event PolicySet(address indexed agent, uint256 dailyCap);
    event CounterpartyAllowed(address indexed agent, bytes32 indexed counterpartyId, bool allowed);
    event SpendExecuted(
        address indexed agent,
        bytes32 indexed counterpartyId,
        uint256 amount,
        bytes32 indexed requestId,
        uint256 day
    );
    event SettlementRelayerUpdated(address indexed relayer);
    event Paused(bool isPaused);
    event AdminWithdraw(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotAgentItself();
    error ContractPaused();
    error NoPolicySet();
    error CounterpartyNotAllowed();
    error DailyCapExceeded();
    error InsufficientBalance();
    error RequestIdAlreadyUsed();
    error ZeroAddress();
    error ZeroAmount();

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    constructor(address _token, address _settlementRelayer) {
        if (_token == address(0) || _settlementRelayer == address(0)) revert ZeroAddress();
        owner = msg.sender;
        token = IERC20(_token);
        settlementRelayer = _settlementRelayer;
    }

    // ---------------------------------------------------------------------
    // Admin (owner) functions
    // ---------------------------------------------------------------------

    /// @notice Set (or update) an agent's daily spend cap.
    /// @dev Does not touch the counterparty allowlist — manage that separately
    ///      via setCounterpartyAllowed so caps and allowlists can be updated
    ///      independently without accidentally wiping one another.
    function setPolicy(address agent, uint256 dailyCap) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        policies[agent] = Policy({dailyCap: dailyCap, exists: true});
        emit PolicySet(agent, dailyCap);
    }

    function setCounterpartyAllowed(address agent, bytes32 counterpartyId, bool allowed) external onlyOwner {
        allowedCounterparty[agent][counterpartyId] = allowed;
        emit CounterpartyAllowed(agent, counterpartyId, allowed);
    }

    function setSettlementRelayer(address relayer) external onlyOwner {
        if (relayer == address(0)) revert ZeroAddress();
        settlementRelayer = relayer;
        emit SettlementRelayerUpdated(relayer);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
    }

    /// @notice Emergency-only. Intentionally restricted to when the contract
    ///         is paused, so it can't be used to quietly drain agent balances
    ///         during normal operation.
    function adminWithdraw(address to, uint256 amount) external onlyOwner {
        if (!paused) revert ContractPaused(); // reused as "must be paused" guard
        if (to == address(0)) revert ZeroAddress();
        bool ok = token.transfer(to, amount);
        require(ok, "transfer failed");
        emit AdminWithdraw(to, amount);
    }

    // ---------------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------------

    /// @notice Fund an agent's balance. Callable by anyone (the org treasury,
    ///         a top-up script, etc.) — funds are attributed to `agent`
    ///         regardless of who sends them.
    function deposit(address agent, uint256 amount) external whenNotPaused {
        if (agent == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        bool ok = token.transferFrom(msg.sender, address(this), amount);
        require(ok, "transferFrom failed");
        balances[agent] += amount;
        emit Deposited(agent, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Spend
    // ---------------------------------------------------------------------

    /// @notice The agent authorizes a payment to `counterpartyId` for `amount`.
    ///         Must be called by the agent's own address.
    /// @param counterpartyId keccak256 of the off-chain counterparty identifier
    ///        (e.g. keccak256("moove-handle:some-provider")).
    /// @param requestId a caller-supplied idempotency key, unique per spend
    ///        attempt. Reusing one reverts.
    function spend(bytes32 counterpartyId, uint256 amount, bytes32 requestId)
        external
        whenNotPaused
        returns (uint256 day)
    {
        address agent = msg.sender;

        if (amount == 0) revert ZeroAmount();
        if (usedRequestIds[requestId]) revert RequestIdAlreadyUsed();

        Policy memory policy = policies[agent];
        if (!policy.exists) revert NoPolicySet();
        if (!allowedCounterparty[agent][counterpartyId]) revert CounterpartyNotAllowed();
        if (balances[agent] < amount) revert InsufficientBalance();

        day = block.timestamp / 1 days;
        uint256 spentToday = spentOnDay[agent][day];
        if (spentToday + amount > policy.dailyCap) revert DailyCapExceeded();

        // Effects before interaction (checks-effects-interactions).
        usedRequestIds[requestId] = true;
        balances[agent] -= amount;
        spentOnDay[agent][day] = spentToday + amount;

        bool ok = token.transfer(settlementRelayer, amount);
        require(ok, "transfer to relayer failed");

        emit SpendExecuted(agent, counterpartyId, amount, requestId, day);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function remainingDailyAllowance(address agent) external view returns (uint256) {
        Policy memory policy = policies[agent];
        if (!policy.exists) return 0;
        uint256 day = block.timestamp / 1 days;
        uint256 spentToday = spentOnDay[agent][day];
        if (spentToday >= policy.dailyCap) return 0;
        return policy.dailyCap - spentToday;
    }

    function balanceOf(address agent) external view returns (uint256) {
        return balances[agent];
    }
}