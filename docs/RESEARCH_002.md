Gemini 3.1 Pro 260519

The Tezos ecosystem is currently undergoing a major transition in its testing infrastructure. Ghostnet, the long-standing primary testnet, is officially being deprecated and replaced by a more robust, Mainnet-accurate environment called Shadownet.

Here is a breakdown of why this transition is happening, what the new network brings to the table, and what developers need to know to migrate.


The Phase-Out of Ghostnet

For years, Ghostnet served as the default, long-lived testnet for Tezos. It was designed to automatically adopt Mainnet protocol upgrades, giving developers a stable testing ground without having to constantly migrate to new, protocol-specific testnets (like Granadanet or Ithacanet).  

However, as the Tezos network architecture has matured—especially with the push toward rollups and the "Tezos X" scaling roadmap—Ghostnet has been designated as a legacy network. It is currently in the process of being fully decommissioned. Major ecosystem providers are already pulling back support; for example, ECAD Labs is shutting down its free public Tezos RPC service endpoints in late May 2026. Developers who remain on Ghostnet will soon find their applications unable to broadcast transactions or sync with the network.  


The Replacement: Shadownet

To replace Ghostnet, the Tezos ecosystem has introduced Shadownet as the new primary test network. Rather than just being a sandbox for early experiments, Shadownet is designed to be a true pre-production staging environment.

Key Features of Shadownet
- Mainnet-Mimicking Validator Distribution: Shadownet is structurally much closer to the actual Tezos Mainnet. The stake (XTZ) of the largest validators (bakers) on Shadownet is distributed to artificially mimic the exact distribution of the largest bakers on Mainnet. This ensures that network behavior, consensus dynamics, and block finality closely replicate real-world conditions.
- Native Tooling Support: Shadownet is baked directly into the core Tezos software. Starting from Octez v24, Shadownet is a built-in network alias, meaning node operators can initialize a Shadownet node natively without manually fetching custom network configuration files.
- Integration with Tezos X & Tezlink: Shadownet serves as the testing ground for the highly anticipated Tezlink rollup environment (part of the Tezos X scaling upgrade). The Tezlink Shadownet allows developers to deploy existing Michelson, SmartPy, and Ligo smart contracts into a high-throughput rollup environment with sub-second latency, preparing applications for the future where Layer 1 becomes primarily a settlement layer.


Migration Steps for Developers and Node Operators

If you are currently maintaining decentralized applications (dApps), smart contracts, or infrastructure on Tezos, migrating from Ghostnet to Shadownet should be your immediate priority.

- Update Node Configurations: If you run your own infrastructure, you will need to reinitialize your Octez node using the new network flag. You can initialize a new data directory simply by running octez-node config init --network shadownet.
- Repoint RPC Endpoints: Update your dApp's front-end and backend scripts to point to Shadownet public RPC endpoints (e.g., [https://rpc.shadownet.teztnets.com](https://rpc.shadownet.teztnets.com)) instead of the old Ghostnet URLs.
- Switch Wallets and Get Test Tokens: Major Tezos wallets like Temple and MetaMask (via the Tezos Snap) now natively support Shadownet. You will need to toggle your wallet's network settings to Shadownet and use the new Shadownet Faucet to fund your testing addresses, as Ghostnet tez cannot be transferred.
- Re-Originate Contracts: Because Shadownet is an entirely separate ledger with its own genesis, any smart contracts previously deployed on Ghostnet must be re-compiled and re-originated (deployed) onto Shadownet.