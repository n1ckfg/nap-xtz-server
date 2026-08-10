(*
  FA2 NAPLPS Contract — CameLIGO (LIGO 0.70 / macOS-m1 npm tag)
  ==============================================================
  A minimal FA2-compatible (TZIP-12) NFT contract that stores NAPLPS vector
  graphics data in each token's metadata map under the key "naplps".

  ── Compile ───────────────────────────────────────────────────────────────────
    npx ligolang@macos-m1 compile contract fa2-naplps.mligo \
      --entry-point main \
      --output-file fa2-naplps.tz

  ── Initial storage (Micheline) for origination ───────────────────────────────
    (Pair (Pair {} 0) {} {})

  ── Originate with octez-client ──────────────────────────────────────────────
    octez-client --endpoint https://rpc.shadownet.teztnets.com \
      originate contract fa2-naplps \
      transferring 0 from <my-account> \
      running fa2-naplps.tz \
      --init '(Pair (Pair {} {}) (Pair {} 0))' \
      --burn-cap 2

  Copy the KT1... address into CONTRACT_ADDRESS in js/tezos/tezos.js.
*)

(* ── Types ─────────────────────────────────────────────────────────────────── *)

type token_id = nat

type ledger    = ((address * token_id), nat) big_map
type operators = ((address * (address * token_id)), unit) big_map

type token_info = (string, bytes) map

type token_metadata_value = {
    token_id   : token_id;
    token_info : token_info;
}

type token_metadata = (token_id, token_metadata_value) big_map

type storage = {
    ledger         : ledger;
    operators      : operators;
    token_metadata : token_metadata;
    next_token_id  : token_id;
}

(* ── FA2 parameter types ────────────────────────────────────────────────────── *)

type transfer_destination = {
    to_      : address;
    token_id : token_id;
    amount   : nat;
}

type transfer_param = {
    from_ : address;
    txs   : transfer_destination list;
}

type balance_of_request = {
    owner    : address;
    token_id : token_id;
}

type balance_of_response = {
    request : balance_of_request;
    balance : nat;
}

type balance_of_param = {
    requests : balance_of_request list;
    callback : (balance_of_response list) contract;
}

type update_operator = {
    owner    : address;
    operator : address;
    token_id : token_id;
}

type update_operator_param =
    | Add_operator    of update_operator
    | Remove_operator of update_operator

type mint_param = {
    to_      : address;
    metadata : token_info;
}

type parameter =
    | Transfer         of transfer_param list
    | Balance_of       of balance_of_param
    | Update_operators of update_operator_param list
    | Mint             of mint_param

(* ── Transfer helpers ───────────────────────────────────────────────────────── *)

let nat_or_zero (opt : nat option) : nat =
    match opt with
    | None   -> 0n
    | Some n -> n

let do_transfer (s : storage) (from_ : address) (tx : transfer_destination) : storage =
    let sender = Tezos.get_sender () in
    let () =
        if sender <> from_ then
            if not (Big_map.mem (from_, (sender, tx.token_id)) s.operators)
            then failwith "FA2_NOT_OPERATOR"
    in
    let from_key  = (from_, tx.token_id) in
    let from_bal  = nat_or_zero (Big_map.find_opt from_key s.ledger) in
    let ()        = if from_bal < tx.amount then failwith "FA2_INSUFFICIENT_BALANCE" in
    let new_from  = abs (from_bal - tx.amount) in
    let ledger    =
        if new_from = 0n
        then Big_map.remove from_key s.ledger
        else Big_map.update from_key (Some new_from) s.ledger
    in
    let to_key = (tx.to_, tx.token_id) in
    let to_bal = nat_or_zero (Big_map.find_opt to_key ledger) in
    let ledger = Big_map.update to_key (Some (to_bal + tx.amount)) ledger in
    { s with ledger }

let apply_txs (s : storage) (param : transfer_param) : storage =
    List.fold_left
        (fun (acc, tx : storage * transfer_destination) -> do_transfer acc param.from_ tx)
        s
        param.txs

let transfer (params : transfer_param list) (s : storage) : operation list * storage =
    let s = List.fold_left
        (fun (acc, p : storage * transfer_param) -> apply_txs acc p)
        s
        params
    in
    ([], s)

(* ── Balance_of ─────────────────────────────────────────────────────────────── *)

let balance_of (param : balance_of_param) (s : storage) : operation list * storage =
    let ledger = s.ledger in
    let responses = List.map
        (fun (req : balance_of_request) ->
            let bal = nat_or_zero (Big_map.find_opt (req.owner, req.token_id) ledger) in
            { request = req; balance = bal })
        param.requests
    in
    let op = Tezos.transaction responses 0mutez param.callback in
    ([op], s)

(* ── Update_operators ───────────────────────────────────────────────────────── *)

let apply_operator_update (ops : operators) (param : update_operator_param) : operators =
    match param with
    | Add_operator op ->
        let () = if Tezos.get_sender () <> op.owner then failwith "FA2_NOT_OWNER" in
        Big_map.update (op.owner, (op.operator, op.token_id)) (Some ()) ops
    | Remove_operator op ->
        let () = if Tezos.get_sender () <> op.owner then failwith "FA2_NOT_OWNER" in
        Big_map.remove (op.owner, (op.operator, op.token_id)) ops

let update_operators
        (params : update_operator_param list) (s : storage)
        : operation list * storage =
    let ops = List.fold_left
        (fun (acc, p : operators * update_operator_param) -> apply_operator_update acc p)
        s.operators
        params
    in
    ([], { s with operators = ops })

(* ── Mint ───────────────────────────────────────────────────────────────────── *)

let mint (param : mint_param) (s : storage) : operation list * storage =
    let token_id = s.next_token_id in
    let ledger   = Big_map.update (param.to_, token_id) (Some 1n) s.ledger in
    let meta     : token_metadata_value =
        { token_id = token_id; token_info = param.metadata }
    in
    let token_metadata =
        Big_map.update token_id (Some meta) s.token_metadata
    in
    ( [],
      { s with
        ledger        = ledger;
        token_metadata = token_metadata;
        next_token_id = token_id + 1n } )

(* ── Main ───────────────────────────────────────────────────────────────────── *)

let main (param : parameter) (s : storage) : operation list * storage =
    match param with
    | Transfer params         -> transfer params s
    | Balance_of param        -> balance_of param s
    | Update_operators params -> update_operators params s
    | Mint param              -> mint param s
