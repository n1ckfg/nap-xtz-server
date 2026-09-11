// The cycle of slides the backend runs: the Raspberry Pi's while a page is in
// drawing mode, and a page's own slideshow in review mode. It is one cycle, so
// the page and the Pi agree on what comes next.
//
// It takes turns: a token from the chain, then one of the slideshow's local
// files at random, then the next token. The tokens go newest first, back to #0,
// then round to the newest again. A new mint puts the count back at the newest
// -- the watcher has already sent that one to the Pi and to every page, so it
// counts as the chain's turn: a full interval, then a local file, then the
// token before it.
//
// This used to run in the page, which fetched every drawing only to send it
// straight back for the Pi. The backend has the chain and the files to hand,
// so pages now only say when they join and leave, and app.js wires this to its
// TzKT reads, the slideshow folder, the Pi links and the pages running their
// slideshow, which get each slide as the Pi does.
//
// Each tick schedules the next when its reads are done, so a slow one can't
// stack ticks up, but times it from when it began, so reads don't stretch the
// interval either. Every start, stop and restart bumps `run`, and a tick checks
// it after each read: one still out when a mint lands must not then put an
// older drawing over the new one.

// A chain turn that meets ids with no drawing passes over them in the same
// tick, up to this many reads, so a long run of them can't fire off a burst.
const MAX_READS = 5;

// The page sends its slideshow interval; these keep one that's missing or
// absurd from setting the chain reads going far too often, or hardly at all.
const DEFAULT_INTERVAL = 10000;
const MIN_INTERVAL = 2000;
const MAX_INTERVAL = 10 * 60 * 1000;

function clampInterval(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, n));
}

class RpiCycle {
  // readToken(id) -> { id, naplps, link }, or null for an id with no drawing
  // newestId()    -> the newest id on chain, or -1 when there are none
  // readLocal()   -> { file, naplps } for a random local file
  // send(slide)   -> shows a slide: { source, naplps }, plus the token's `id`
  //                  and `link` or the local `file`
  // canSend()     -> whether anybody is watching: a Pi, or a page's slideshow
  // clock         -> { setTimeout, clearTimeout, now }, for tests
  constructor(options) {
    this.readToken = options.readToken;
    this.newestId = options.newestId;
    this.readLocal = options.readLocal;
    this.send = options.send;
    this.canSend = options.canSend;
    this.onError = options.onError || function() {};
    this.clock = options.clock || { setTimeout, clearTimeout, now: Date.now };

    this.clients = new Map();   // page (socket id) -> the interval it asked for
    this.interval = DEFAULT_INTERVAL;
    this.localTurn = false;     // whose turn is next: a local file's, or the chain's
    this.nextId = null;         // the chain's next token; null for whichever is newest
    this.lastSlide = null;      // the slide showing now, for a slideshow that joins partway
    this.timer = null;
    this.run = 0;
  }

  get running() {
    return this.clients.size > 0;
  }

  // A page joining or leaving -- disconnecting counts as leaving. The cycle
  // runs while any page is in it, at the interval the latest to join asked for.
  setClient(id, active, interval) {
    const wasRunning = this.running;
    if (active) {
      this.interval = clampInterval(interval);
      this.clients.set(id, this.interval);
    } else {
      this.clients.delete(id);
    }

    if (this.running && !wasRunning) this._start();
    else if (!this.running && wasRunning) this._stop();
  }

  // A new mint has just gone to the Pi and to every page, which was the chain's
  // turn: it is the slide showing now.
  minted(token) {
    if (!this.running) return;
    this.lastSlide = { source: 'chain', naplps: token.naplps, id: token.id, link: token.link };
    this.localTurn = true;
    this.nextId = token.id > 0 ? token.id - 1 : null;
    this._schedule(this.interval);
  }

  _start() {
    this.localTurn = false;   // the newest token goes first
    this.nextId = null;
    this._schedule(0);
  }

  _stop() {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.lastSlide = null;
    this.run++;
  }

  _schedule(delay) {
    this.clock.clearTimeout(this.timer);
    const run = ++this.run;
    this.timer = this.clock.setTimeout(() => this._tick(run), delay);
  }

  _show(slide) {
    this.lastSlide = slide;
    this.send(slide);
  }

  async _tick(run) {
    const started = this.clock.now();
    try {
      // With nobody watching -- no Pi listening, no page running its slideshow
      // -- there is no one to read any of it for, and the turn waits.
      if (!this.canSend()) return;

      // The turn passes on whatever this one comes to, so a chain that can't
      // be read or a file that won't load costs only its own slot.
      const localTurn = this.localTurn;
      this.localTurn = !localTurn;

      if (localTurn) {
        const local = await this.readLocal();
        if (run !== this.run) return;
        this._show({ source: 'cycle-local', naplps: local.naplps, file: local.file });
        return;
      }

      for (let reads = 0; reads < MAX_READS; reads++) {
        let id = this.nextId;
        if (id === null) {
          id = await this.newestId();
          if (run !== this.run || id < 0) return;   // stale, or nothing minted yet
        }

        const token = await this.readToken(id);
        if (run !== this.run) return;

        this.nextId = id > 0 ? id - 1 : null;   // below #0 is round to the newest
        if (token) {
          this._show({ source: 'cycle-chain', naplps: token.naplps, id: token.id, link: token.link });
          return;
        }
      }
    } catch (err) {
      // A token that failed to read leaves the count where it was, for the
      // chain's next turn.
      this.onError(err);
    } finally {
      if (run === this.run) this._schedule(Math.max(0, this.interval - (this.clock.now() - started)));
    }
  }
}

module.exports = { RpiCycle, clampInterval, MAX_READS, DEFAULT_INTERVAL, MIN_INTERVAL, MAX_INTERVAL };
