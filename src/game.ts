import { randomInt } from 'node:crypto';

export type DiceMode = 'virtual' | 'manual';
export type Phase = 'lobby' | 'playing' | 'reveal' | 'gameover';
export type Dice = [number, number];
export type RollEffect = 'add' | 'seventy' | 'double' | 'bust';

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 20;
export const DEFAULT_ROUNDS = 20;
export const MAX_ROUNDS = 100;
export const SAFE_ROLLS = 3;
export const ROLL_COOLDOWN_MS = 2000;
export const MAX_NAME_LENGTH = 20;

export interface Player {
  id: string;
  name: string;
  score: number;
  connected: boolean;
  /** Pot value locked in this round, or null if not banked. Secret until the round ends. */
  bank: number | null;
}

export interface Roll {
  playerId: string;
  playerName: string;
  sum: number;
  doubles: boolean;
  /** The individual dice for virtual rolls; null when a player entered a real-dice roll. */
  dice: Dice | null;
  effect: RollEffect;
  potAfter: number;
}

export interface RoundResult {
  round: number;
  /** Name of the player who rolled the 7, or null if everyone banked. */
  bustedBy: string | null;
  finalPot: number;
  banks: { playerId: string; name: string; amount: number | null }[];
}

/** A rule violation that should be shown to the player who caused it. */
export class GameError extends Error {}

/**
 * Scores one roll. During the first SAFE_ROLLS rolls of a round a 7 is worth 70 and
 * doubles just add their sum; after that a 7 busts and doubles double the pot.
 */
export function applyRoll(
  pot: number,
  rollNumber: number,
  sum: number,
  doubles: boolean,
): { effect: RollEffect; pot: number } {
  if (rollNumber <= SAFE_ROLLS) {
    return sum === 7 ? { effect: 'seventy', pot: pot + 70 } : { effect: 'add', pot: pot + sum };
  }
  if (sum === 7) return { effect: 'bust', pot };
  if (doubles) return { effect: 'double', pot: pot * 2 };
  return { effect: 'add', pot: pot + sum };
}

/** Validates a real-dice roll entered as a total plus whether it was doubles. */
function parseManualRoll(input: unknown): { sum: number; doubles: boolean } {
  const { sum, doubles } = (input ?? {}) as { sum?: unknown; doubles?: unknown };
  if (!Number.isInteger(sum) || (sum as number) < 2 || (sum as number) > 12) {
    throw new GameError('Pick what your dice added up to (2 to 12)');
  }
  // 2 and 12 can only be rolled as doubles.
  if (sum === 2 || sum === 12) return { sum, doubles: true };
  if (doubles === true && (sum as number) % 2 === 1) throw new GameError("Doubles can't add up to an odd number");
  return { sum: sum as number, doubles: doubles === true };
}

export interface GameOptions {
  now?: () => number;
  /** Returns an integer in [0, max). */
  random?: (max: number) => number;
}

export class Game {
  phase: Phase = 'lobby';
  /** In turn order. */
  players: Player[] = [];
  hostId: string | null = null;
  rounds = DEFAULT_ROUNDS;
  diceMode: DiceMode = 'virtual';
  round = 0;
  pot = 0;
  rolls: Roll[] = [];
  turnIndex = 0;
  nextRollAt = 0;
  lastResult: RoundResult | null = null;

  private readonly now: () => number;
  private readonly random: (max: number) => number;

  constructor(options: GameOptions = {}) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? ((max) => randomInt(max));
  }

  player(id: string): Player | undefined {
    return this.players.find((p) => p.id === id);
  }

  get currentPlayer(): Player | undefined {
    return this.phase === 'playing' ? this.players[this.turnIndex] : undefined;
  }

  join(id: string, rawName: string): void {
    if (this.player(id)) return;
    const name = rawName.trim().slice(0, MAX_NAME_LENGTH);
    if (!name) throw new GameError('Enter a name');
    if (this.phase !== 'lobby') throw new GameError('A game is already in progress');
    if (this.players.length >= MAX_PLAYERS) throw new GameError(`The game is full (${MAX_PLAYERS} players max)`);
    if (this.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('That name is taken');
    }
    this.players.push({ id, name, score: 0, connected: true, bank: null });
    this.hostId ??= id;
  }

  setConnected(id: string, connected: boolean): void {
    const player = this.player(id);
    if (player) player.connected = connected;
  }

  updateSettings(id: string, settings: { rounds?: unknown; diceMode?: unknown }): void {
    this.requireHost(id);
    if (this.phase !== 'lobby') throw new GameError('Settings can only be changed before the game starts');
    if (settings.rounds !== undefined) {
      const rounds = settings.rounds;
      if (!Number.isInteger(rounds) || (rounds as number) < 1 || (rounds as number) > MAX_ROUNDS) {
        throw new GameError(`Rounds must be between 1 and ${MAX_ROUNDS}`);
      }
      this.rounds = rounds as number;
    }
    if (settings.diceMode !== undefined) {
      if (settings.diceMode !== 'virtual' && settings.diceMode !== 'manual') throw new GameError('Unknown dice mode');
      this.diceMode = settings.diceMode;
    }
  }

  start(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'lobby') throw new GameError('The game has already started');
    if (this.players.length < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    for (const p of this.players) p.score = 0;
    this.round = 1;
    this.turnIndex = this.random(this.players.length);
    this.startRound();
  }

  /**
   * Rolls for the current player. With real dice, the host enters everyone's rolls.
   * `rollNumber` (if given) must be the roll being entered, so a repeated submission
   * isn't counted twice.
   */
  roll(id: string, manualRoll?: unknown, rollNumber?: unknown): void {
    if (this.phase !== 'playing') throw new GameError('Nobody is rolling right now');
    const roller = this.currentPlayer!;
    if (this.diceMode === 'manual') {
      if (id !== this.hostId) throw new GameError('Only the host enters rolls');
    } else if (roller.id !== id) {
      throw new GameError("It's not your turn");
    }
    if (rollNumber !== undefined && rollNumber !== this.rolls.length + 1) {
      throw new GameError('That roll was already entered');
    }
    if (this.now() < this.nextRollAt) throw new GameError('Hang on, too fast!');

    let dice: Dice | null = null;
    let sum: number;
    let doubles: boolean;
    if (this.diceMode === 'manual') {
      ({ sum, doubles } = parseManualRoll(manualRoll));
    } else {
      dice = [this.rollDie(), this.rollDie()];
      sum = dice[0] + dice[1];
      doubles = dice[0] === dice[1];
    }
    const result = applyRoll(this.pot, this.rolls.length + 1, sum, doubles);
    this.pot = result.pot;
    this.rolls.push({
      playerId: roller.id,
      playerName: roller.name,
      sum,
      doubles,
      dice,
      effect: result.effect,
      potAfter: result.pot,
    });
    this.advanceTurn();

    if (result.effect === 'bust') this.endRound(roller.name);
    else this.nextRollAt = this.now() + ROLL_COOLDOWN_MS;
  }

  /** Returns true if this bank ended the round (everyone has now banked). */
  bank(id: string): boolean {
    if (this.phase !== 'playing') throw new GameError('There is nothing to bank right now');
    const player = this.requirePlayer(id);
    if (player.bank !== null) throw new GameError('You already banked this round');
    if (this.pot === 0) throw new GameError('Nothing to bank yet');
    player.bank = this.pot;
    return this.endRoundIfAllBanked();
  }

  skipTurn(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'playing') throw new GameError('Nobody is rolling right now');
    this.advanceTurn();
  }

  removePlayer(id: string, targetId: string): void {
    this.requireHost(id);
    if (targetId === id) throw new GameError("You can't remove yourself. Use Leave instead.");
    this.dropPlayer(targetId);
  }

  leave(id: string): void {
    this.dropPlayer(id);
  }

  nextRound(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'reveal') throw new GameError('The round is not over yet');
    this.round++;
    this.startRound();
  }

  playAgain(id: string): void {
    this.requireHost(id);
    if (this.phase !== 'gameover') throw new GameError('The game is not over yet');
    this.phase = 'lobby';
    this.round = 0;
    this.pot = 0;
    this.rolls = [];
    this.lastResult = null;
    for (const p of this.players) {
      p.score = 0;
      p.bank = null;
    }
  }

  winnerIds(): string[] {
    const best = Math.max(...this.players.map((p) => p.score));
    return this.players.filter((p) => p.score === best).map((p) => p.id);
  }

  /** The game state as seen by one player: other players' banks stay hidden until the round ends. */
  viewFor(viewerId: string | null) {
    const me = viewerId ? this.player(viewerId) : undefined;
    const roundOver = this.phase === 'reveal' || this.phase === 'gameover';
    return {
      phase: this.phase,
      youId: me?.id ?? null,
      hostId: this.hostId,
      rounds: this.rounds,
      diceMode: this.diceMode,
      round: this.round,
      pot: this.pot,
      rolls: this.rolls,
      currentPlayerId: this.currentPlayer?.id ?? null,
      cooldownMs: Math.max(0, this.nextRollAt - this.now()),
      players: this.players.map(({ id, name, score, connected }) => ({ id, name, score, connected })),
      yourBank: me?.bank ?? null,
      lastResult: roundOver ? this.lastResult : null,
      winnerIds: this.phase === 'gameover' ? this.winnerIds() : [],
      limits: { minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS, maxRounds: MAX_ROUNDS, safeRolls: SAFE_ROLLS },
    };
  }

  private startRound(): void {
    this.phase = 'playing';
    this.pot = 0;
    this.rolls = [];
    this.nextRollAt = 0;
    this.lastResult = null;
    for (const p of this.players) p.bank = null;
  }

  private endRound(bustedBy: string | null): void {
    for (const p of this.players) p.score += p.bank ?? 0;
    this.lastResult = {
      round: this.round,
      bustedBy,
      finalPot: this.pot,
      banks: this.players.map((p) => ({ playerId: p.id, name: p.name, amount: p.bank })),
    };
    this.phase = this.round >= this.rounds ? 'gameover' : 'reveal';
  }

  private endRoundIfAllBanked(): boolean {
    if (this.players.some((p) => p.bank === null)) return false;
    this.endRound(null);
    return true;
  }

  private advanceTurn(): void {
    this.turnIndex = (this.turnIndex + 1) % this.players.length;
  }

  private dropPlayer(id: string): void {
    const index = this.players.findIndex((p) => p.id === id);
    if (index === -1) throw new GameError('That player is not in the game');
    this.players.splice(index, 1);

    if (this.players.length === 0) {
      Object.assign(this, new Game({ now: this.now, random: this.random }));
      return;
    }
    // Keep the turn on whoever was next in line.
    if (index < this.turnIndex) this.turnIndex--;
    this.turnIndex %= this.players.length;
    if (this.hostId === id) this.hostId = this.players[index % this.players.length].id;

    if (this.phase === 'lobby' || this.phase === 'gameover') return;
    if (this.players.length < MIN_PLAYERS) {
      if (this.phase === 'playing') this.endRound(null);
      this.phase = 'gameover';
    } else if (this.phase === 'playing') {
      this.endRoundIfAllBanked();
    }
  }

  private rollDie(): number {
    return this.random(6) + 1;
  }

  private requirePlayer(id: string): Player {
    const player = this.player(id);
    if (!player) throw new GameError('You are not in this game');
    return player;
  }

  private requireHost(id: string): void {
    if (id !== this.hostId) throw new GameError('Only the host can do that');
  }
}

export type GameView = ReturnType<Game['viewFor']>;
