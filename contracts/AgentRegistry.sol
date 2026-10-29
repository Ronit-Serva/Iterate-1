// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
interface ICard { function active() external view returns (bool); function cardJson() external view returns (string memory); }
/// @notice Owner-curated local discovery directory; token custody remains in AgentCard.
contract AgentRegistry is Ownable {
    mapping(bytes32 => address) public agents;
    event Registered(bytes32 indexed key, address indexed card);
    event Removed(bytes32 indexed key);
    constructor(address initialOwner) Ownable(initialOwner) {}
    function register(bytes32 key, address card) external onlyOwner {
        require(key != bytes32(0) && card.code.length > 0, "Invalid registration");
        require(ICard(card).active() && bytes(ICard(card).cardJson()).length > 2, "Invalid card");
        agents[key] = card;
        emit Registered(key, card);
    }
    function remove(bytes32 key) external onlyOwner { delete agents[key]; emit Removed(key); }
}
