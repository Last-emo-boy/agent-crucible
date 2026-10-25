// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CrucibleVault} from "./CrucibleVault.sol";
import {VaultFactoryBaseV2} from "./flap/VaultFactoryBaseV2.sol";
import {IVaultFactoryValidationV2} from "./flap/IVaultFactory.sol";
import {IPortalTypes} from "./flap/IPortal.sol";
import {VaultDataSchema, FieldDescriptor} from "./flap/IVaultSchemasV1.sol";

/// @notice Immutable one-vault-per-token factory. No operator can upgrade a vault.
contract CrucibleFactory is VaultFactoryBaseV2 {
    address public immutable agentIdRegistry;
    error UnsupportedQuote();

    constructor(address registry) {
        require(registry.code.length != 0, "Registry has no code");
        agentIdRegistry = registry;
    }

    function newVault(address token, address quote, address creator, bytes calldata data)
        external
        override
        returns (address vault)
    {
        if (msg.sender != _getVaultPortal()) revert OnlyVaultPortal();
        if (quote != address(0)) revert UnsupportedQuote();
        (uint256 minPrize, uint256 commitDuration, uint256 revealDuration) =
            abi.decode(data, (uint256, uint256, uint256));
        vault = address(new CrucibleVault(token, agentIdRegistry, creator, minPrize, commitDuration, revealDuration));
    }

    function isQuoteTokenSupported(address quote) external pure override returns (bool) {
        return quote == address(0);
    }

    function factorySpecVersion() public pure override returns (string memory) {
        return "v2.3";
    }

    function _validateBeforeLaunch(IVaultFactoryValidationV2.LaunchValidationDataV1 memory data)
        internal
        pure
        override
        returns (bool, string memory)
    {
        if (data.quoteToken != address(0)) return (false, "Native BNB only");
        if (data.tokenVersion != IPortalTypes.TokenVersion.TOKEN_TAXED_V3) return (false, "Tax Token V3 required");
        if (data.buyTaxRate != 100 || data.sellTaxRate != 100) return (false, "Fixed 1% buy/sell tax required");
        if (data.vaultBps != 10_000 || data.deflationBps != 0 || data.dividendBps != 0 || data.lpBps != 0) {
            return (false, "All project tax proceeds must reach vault");
        }
        return (true, "");
    }

    function vaultDataSchema() public pure override returns (VaultDataSchema memory schema) {
        schema.description =
            "Agent Crucible: all-pay sealed token bids for BNB prizes. Fixed 1% buy/sell tax; all project revenue to vault. Native BNB only.";
        schema.fields = new FieldDescriptor[](3);
        schema.fields[0] = FieldDescriptor("minPrize", "uint256", "Minimum BNB prize per round", 18);
        schema.fields[1] = FieldDescriptor("commitDuration", "uint256", "Commit period in seconds (suggested 1200)", 0);
        schema.fields[2] = FieldDescriptor("revealDuration", "uint256", "Reveal period in seconds (suggested 600)", 0);
    }
}
