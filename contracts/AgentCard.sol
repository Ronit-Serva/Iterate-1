// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Stores one service's public A2A card and receives its token payments.
contract AgentCard is Ownable {
    using SafeERC20 for IERC20;

    string public cardJson;
    bool public active;

    event CardUpdated(bool active);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);

    constructor(address initialOwner, string memory initialCardJson, bool initiallyActive)
        Ownable(initialOwner)
    {
        cardJson = initialCardJson;
        active = initiallyActive;
    }

    function updateCard(string calldata nextCardJson, bool nextActive) external onlyOwner {
        cardJson = nextCardJson;
        active = nextActive;
        emit CardUpdated(nextActive);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(to, amount);
        emit TokenWithdrawn(token, to, amount);
    }
}
