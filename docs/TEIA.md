**Overview**

The contract is an implementation of the **FA2 standard (TZIP-12)** on the Tezos blockchain, written in **SmartPy** . It extends a standard FA2 template originally created by Seb Mondet to add features specifically needed for the Teia marketplace (formerly Hic et Nunc), such as built-in royalty splits and enhanced token data storage.

**Core Storage Structure**

The contract maintains several BigMaps to handle its state efficiently:

- **ledger** : Tracks the token balances of users (Owner Address, Token ID) -&gt; Balance.
- **supply** : Tracks the total supply for each minted Token ID.
- **operators** : Keeps track of addresses authorized to transfer tokens on behalf of the owner.
- **token\_metadata** : Stores standard TZIP-12 metadata for each token.
- **counter** : An integer tracking the total number of distinct tokens minted so far (also used to assign the next token\_id).

**Teia-Specific Extensions**

Standard FA2 contracts only require basic transfer and metadata logic. Teia has added a few distinct features to this contract:

1. **On-Chain Royalties (token\_royalties)** : The contract natively stores royalty information at the token level, splitting it between the **minter** and the **creator** (useful for collaborations or instances where a smart contract mints on behalf of an artist). Royalties are tracked in "per mille" (where 100 = 10%). The mint entry point enforces a hard cap to ensure combined royalties never exceed 100% (1000 per mille).
2. **Extended Token Data (token\_data)** : A separate big map dedicated to storing additional on-chain token data such as source code, descriptions, or attributes, independently from standard metadata.
3. **On-Chain Views** : The contract implements several sp.onchain\_view methods (like get\_balance, total\_supply, token\_royalties, and token\_data), allowing other smart contracts (like the marketplace contract) to read state instantly without needing callback functions.

**Key Entry Points (Functions)**

- **mint** : Can only be called by the **administrator** . It creates a new token ID, sets the initial supply, assigns the metadata/data, defines the royalties, and updates the ledger.
- **transfer** : Standard FA2 batch transfer. It allows owners or their approved operators to move tokens. It automatically checks for sufficient balances.
- **balance\_of** : Standard FA2 callback-based balance checking.
- **update\_operators** : Allows token owners to add or remove operators (e.g., giving a marketplace contract permission to sell their token).
- **Administrator Controls** :
    - The contract uses a safe, two-step admin transfer process: The current admin proposes a new address (transfer\_administrator), and the new address must actively accept it (accept\_administrator). This prevents accidental locking of the contract by sending admin rights to a typo or dead address.
    - set\_metadata allows the admin to update the contract-level (TZIP-016) metadata.

**In summary:** This is a highly optimized, standard-compliant FA2 NFT contract tailored to Teia's needs, particularly emphasizing robust on-chain royalty management and modular metadata storage.