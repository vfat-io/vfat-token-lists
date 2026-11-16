// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Source of TRANSFER_PROBE_RUNTIME_BYTECODE in scripts/transfer-probe/probe-contract.mjs.
// Recompile with: forge build --optimize --optimizer-runs 200 (solc 0.8.35) and copy
// artifact.deployedBytecode.object. It is deployed via an eth_call `code` state-override AT a
// real token holder's address, so that when the token's transfer() runs, msg.sender is that
// holder (which owns a real balance -- e.g. the AMM pool or v4 pool manager).

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract TransferProbe {
    uint256 private constant MAGIC = 0x5afe70be;

    function magic() external pure returns (uint256) {
        return MAGIC;
    }

    // Confirms that code overrides remain active through the same nested-call depth used by the
    // round-trip probe: holder -> via -> spender.
    function magicAt(address target) external pure returns (uint256) {
        return TransferProbe(target).magic();
    }

    function magicThrough(address via, address spender) external pure returns (uint256) {
        return TransferProbe(via).magicAt(spender);
    }

    // Uses an optional-return-safe transfer and measures the recipient balance delta.
    function probe(address token, address to, uint256 amount) external returns (uint256 received) {
        received = _transfer(token, to, amount);
    }

    // The sell leg uses approve + transferFrom because production swap routers pull tokens from
    // the selling account. All three actors must carry this code through the state override.
    function probeRoundTrip(address token, address via, address spender, uint256 amount)
        external
        returns (uint256 received, uint256 returned)
    {
        received = _transfer(token, via, amount);
        returned = TransferProbe(via).probeTransferFrom(token, spender, address(this), received);
    }

    function probeTransferFrom(address token, address spender, address to, uint256 amount)
        external
        returns (uint256 received)
    {
        // Match the production approval pattern, including USDT-style zero-first approvals.
        _callOptionalReturn(token, abi.encodeWithSelector(0x095ea7b3, spender, 0));
        _callOptionalReturn(token, abi.encodeWithSelector(0x095ea7b3, spender, amount));
        received = TransferProbe(spender).pull(token, address(this), to, amount);
    }

    function pull(address token, address from, address to, uint256 amount) external returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(to);
        // transferFrom(address,address,uint256) == 0x23b872dd
        _callOptionalReturn(token, abi.encodeWithSelector(0x23b872dd, from, to, amount));
        received = IERC20(token).balanceOf(to) - balanceBefore;
    }

    function _transfer(address token, address to, uint256 amount) private returns (uint256 received) {
        uint256 balanceBefore = IERC20(token).balanceOf(to);
        // transfer(address,uint256) == 0xa9059cbb
        _callOptionalReturn(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
        received = IERC20(token).balanceOf(to) - balanceBefore;
    }

    function _callOptionalReturn(address token, bytes memory data) private {
        (bool success, bytes memory ret) = token.call(data);
        if (!success) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "token operation returned false");
    }
}
