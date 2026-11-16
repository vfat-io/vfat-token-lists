// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Installed as runtime code by the in-process EVM tests; balances need no deployment transaction.
contract ProbeToken {
    uint256 private constant MODE = MODE_VALUE;
    address private constant POOL = address(0xb1);
    address private constant RECIPIENT = 0x5Fa7B0A3Ee5a1C1A1b2c3d4E5F60718293a4B5C6;
    mapping(address => int256) private delta;
    mapping(address => mapping(address => uint256)) private allowance;

    function balanceOf(address account) public view returns (uint256) {
        int256 initial;
        if (account == POOL) initial = 1000;
        if (account == RECIPIENT) initial = 100; // funds an extra sender fee on the return leg
        if (account == address(0xb2)) initial = 2000;
        if (account == address(0xb3)) initial = 3000;
        if (account == address(0xb4)) initial = 4000;
        return uint256(initial + delta[account]);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        bool extraDebit = (MODE == 1 && from == POOL) || (MODE == 2 && to == POOL);
        bool shortDelivery = MODE == 3 && (from == POOL || to == POOL);
        uint256 fee = amount / 100;
        uint256 spent = extraDebit ? amount + fee : amount;
        uint256 received = shortDelivery ? amount - fee : amount;
        require(balanceOf(from) >= spent, "insufficient balance");
        delta[from] -= int256(spent);
        delta[to] += int256(received);
    }
}
