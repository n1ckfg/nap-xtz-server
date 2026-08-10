octez-client --endpoint https://rpc.shadownet.teztnets.com \
  originate contract fa2-naplps \
  transferring 0 from my-wallet \
  running fa2-naplps.tz \
  --init '(Pair (Pair {} 0) {} {})' \
  --burn-cap 2
