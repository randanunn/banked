import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameError, applyRoll, ROLL_COOLDOWN_MS, type Dice } from '../src/game.ts';

/** A manual-dice game with a controllable clock, players joined in order, starting with the first player (the host). */
function setup(names: string[], rounds = 20) {
  let time = 0;
  const game = new Game({ now: () => time, random: () => 0 });
  for (const name of names) game.join(name, name);
  game.updateSettings(names[0], { rounds, diceMode: 'manual' });
  game.start(names[0]);
  const roll = (dice: Dice) => {
    game.roll(names[0], { sum: dice[0] + dice[1], doubles: dice[0] === dice[1] });
    time += ROLL_COOLDOWN_MS;
  };
  return { game, roll, tick: (ms: number) => (time += ms) };
}

test('applyRoll: first three rolls cannot bust', () => {
  assert.deepEqual(applyRoll(0, 1, 7, false), { effect: 'seventy', pot: 70 });
  assert.deepEqual(applyRoll(70, 3, 7, false), { effect: 'seventy', pot: 140 });
  assert.deepEqual(applyRoll(10, 2, 10, true), { effect: 'add', pot: 20 });
  assert.deepEqual(applyRoll(10, 2, 5, false), { effect: 'add', pot: 15 });
});

test('applyRoll: from the fourth roll, 7 busts and doubles double', () => {
  assert.deepEqual(applyRoll(50, 4, 7, false), { effect: 'bust', pot: 50 });
  assert.deepEqual(applyRoll(50, 4, 4, true), { effect: 'double', pot: 100 });
  assert.deepEqual(applyRoll(50, 4, 4, false), { effect: 'add', pot: 54 });
  assert.deepEqual(applyRoll(50, 9, 5, false), { effect: 'add', pot: 55 });
});

test('first player to join is host and only the host can start', () => {
  const game = new Game();
  game.join('a', 'Ann');
  game.join('b', 'Bob');
  assert.equal(game.hostId, 'a');
  assert.throws(() => game.start('b'), GameError);
  assert.throws(() => game.updateSettings('b', { rounds: 5 }), GameError);
  game.start('a');
  assert.equal(game.phase, 'playing');
});

test('needs at least two players and rejects duplicate names and late joiners', () => {
  const game = new Game();
  game.join('a', 'Ann');
  assert.throws(() => game.start('a'), /at least 2/);
  assert.throws(() => game.join('b', 'ann'), /taken/);
  game.join('b', 'Bob');
  game.start('a');
  assert.throws(() => game.join('c', 'Cat'), /in progress/);
  assert.doesNotThrow(() => game.join('a', 'Ann')); // reconnecting is fine
});

test('the host can reorder players in the lobby only', () => {
  const game = new Game();
  for (const id of ['a', 'b', 'c']) game.join(id, id);
  assert.throws(() => game.movePlayer('b', 'c', -1), /Only the host/);
  game.movePlayer('a', 'c', -1);
  assert.deepEqual(
    game.players.map((p) => p.id),
    ['a', 'c', 'b'],
  );
  game.movePlayer('a', 'a', 1);
  game.movePlayer('a', 'b', 1); // already last: no-op
  assert.deepEqual(
    game.players.map((p) => p.id),
    ['c', 'a', 'b'],
  );
  assert.throws(() => game.movePlayer('a', 'b', 2), /Unknown move/);
  game.start('a');
  assert.throws(() => game.movePlayer('a', 'b', -1), /before the game starts/);
});

test('settings are locked once the game starts', () => {
  const { game } = setup(['a', 'b']);
  assert.throws(() => game.updateSettings('a', { diceMode: 'virtual' }), /before the game starts/);
});

test('with virtual dice, players must roll in turn and respect the cooldown', () => {
  let time = 0;
  const game = new Game({ now: () => time, random: () => 0 });
  game.join('a', 'Ann');
  game.join('b', 'Bob');
  game.start('a');
  assert.throws(() => game.roll('b'), /not your turn/);
  game.roll('a');
  assert.throws(() => game.roll('b'), /too fast/);
  time += ROLL_COOLDOWN_MS;
  game.roll('b');
  assert.equal(game.pot, 4);
});

test('with real dice, only the host enters rolls, for every player', () => {
  const { game, tick } = setup(['a', 'b', 'c']);
  assert.throws(() => game.roll('b', { sum: 3 }), /Only the host/);
  assert.throws(() => game.roll('c', { sum: 3 }), /Only the host/);
  game.roll('a', { sum: 3 }, 1);
  assert.equal(game.rolls[0].playerId, 'a');
  tick(ROLL_COOLDOWN_MS);
  assert.throws(() => game.roll('b', { sum: 3 }), /Only the host/); // not even on their own turn
  assert.throws(() => game.roll('a', { sum: 3 }, 1), /already entered/); // repeated submission
  game.roll('a', { sum: 4 }, 2);
  assert.equal(game.rolls[1].playerId, 'b');
});

test('real dice are entered as a total plus a doubles flag', () => {
  const { game, roll, tick } = setup(['a', 'b']);
  assert.throws(() => game.roll('a', { sum: 1 }), /2 to 12/);
  assert.throws(() => game.roll('a', { sum: 13 }), /2 to 12/);
  assert.throws(() => game.roll('a', { sum: 5, doubles: true }), /odd/);
  game.roll('a', { sum: 12 }); // 12 is always doubles
  assert.deepEqual(game.rolls[0], { ...game.rolls[0], sum: 12, doubles: true, dice: null });
  tick(ROLL_COOLDOWN_MS);
  roll([1, 1]);
  roll([1, 1]);
  game.roll('a', { sum: 2 }); // roll 4: 2 is doubles, so the pot doubles
  assert.equal(game.pot, 32);
});

test('virtual dice are rolled by the server', () => {
  const game = new Game({ random: (max) => (max === 6 ? 2 : 0) }); // every die shows 3
  game.join('a', 'Ann');
  game.join('b', 'Bob');
  game.start('a');
  game.roll('a');
  assert.deepEqual(game.rolls[0].dice, [3, 3]);
  assert.equal(game.rolls[0].doubles, true);
  assert.equal(game.pot, 6);
});

test('banks are secret until the round ends', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([3, 4]); // 70
  game.bank('b');
  assert.equal(game.viewFor('b').yourBank, 70);
  assert.equal(game.viewFor('a').yourBank, null);
  assert.equal(game.viewFor('a').lastResult, null);
  assert.ok(!JSON.stringify(game.viewFor('a')).includes('"bank"'));
});

test('banking is final and needs a non-empty pot', () => {
  const { game, roll } = setup(['a', 'b']);
  assert.throws(() => game.bank('a'), /Nothing to bank/);
  roll([1, 2]);
  game.bank('a');
  assert.throws(() => game.bank('a'), /already banked/);
});

test('banked players keep rolling and the round ends when everyone banks', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([3, 4]); // a: 70
  game.bank('a');
  roll([1, 1]); // b: 72
  roll([1, 2]); // c: 75
  game.bank('b');
  assert.equal(game.currentPlayer!.id, 'a'); // a still takes their turn
  roll([5, 5]); // a: 150
  assert.equal(game.bank('c'), true);
  assert.equal(game.phase, 'reveal');
  assert.deepEqual(
    game.players.map((p) => p.score),
    [70, 75, 150],
  );
  assert.equal(game.viewFor('a').lastResult?.bustedBy, null);
});

test('a bust pays banked players and gives everyone else nothing', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([2, 3]); // 5
  roll([2, 3]); // 10
  game.bank('c');
  roll([2, 3]); // 15
  game.bank('a');
  roll([3, 4]); // a busts on roll 4
  assert.equal(game.phase, 'reveal');
  assert.deepEqual(
    game.players.map((p) => p.score),
    [15, 0, 10],
  );
  const result = game.viewFor('b').lastResult!;
  assert.equal(result.bustedBy, 'a');
  assert.deepEqual(
    result.banks.map((b) => b.amount),
    [15, null, 10],
  );
});

test('the next round starts with whoever would have rolled next', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  for (let i = 0; i < 4; i++) roll([1, 2]);
  roll([3, 4]); // b busts on roll 5
  assert.throws(() => game.nextRound('b'), /Only the host/);
  game.nextRound('a');
  assert.equal(game.round, 2);
  assert.equal(game.pot, 0);
  assert.equal(game.currentPlayer!.id, 'c');
  assert.equal(game.nextRollAt, 0);
});

test('the game ends after the configured rounds, ties share the win, and play again resets', () => {
  const { game, roll } = setup(['a', 'b', 'c'], 1);
  roll([3, 4]);
  game.bank('a');
  game.bank('b');
  game.bank('c');
  assert.equal(game.phase, 'gameover');
  assert.deepEqual(game.winnerIds(), ['a', 'b', 'c']);
  game.playAgain('a');
  assert.equal(game.phase, 'lobby');
  assert.ok(game.players.every((p) => p.score === 0));
});

test('host can skip turns', () => {
  const { game } = setup(['a', 'b', 'c']);
  assert.throws(() => game.skipTurn('b'), /Only the host/);
  game.skipTurn('a');
  assert.equal(game.currentPlayer!.id, 'b');
});

test('removing the current roller passes the turn to the next player', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([1, 2]); // now b's turn
  game.removePlayer('a', 'b');
  assert.equal(game.currentPlayer!.id, 'c');
  assert.throws(() => game.removePlayer('a', 'a'), /Leave/);
});

test('removing an earlier player keeps the turn on the same person', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([1, 2]);
  roll([1, 2]); // now c's turn
  game.removePlayer('a', 'b');
  assert.equal(game.currentPlayer!.id, 'c');
});

test('removing the last unbanked player ends the round', () => {
  const { game, roll } = setup(['a', 'b', 'c']);
  roll([1, 2]);
  game.bank('a');
  game.bank('b');
  game.removePlayer('a', 'c');
  assert.equal(game.phase, 'reveal');
});

test('when the host leaves, host passes to the next player in turn order', () => {
  const { game } = setup(['a', 'b', 'c']);
  game.leave('a');
  assert.equal(game.hostId, 'b');
});

test('dropping below two players ends the game', () => {
  const { game } = setup(['a', 'b']);
  game.leave('b');
  assert.equal(game.phase, 'gameover');
  assert.deepEqual(game.winnerIds(), ['a']);
});

test('everyone leaving resets to an empty lobby', () => {
  const { game } = setup(['a', 'b']);
  game.leave('a');
  game.leave('b');
  assert.equal(game.phase, 'lobby');
  assert.equal(game.hostId, null);
  game.join('c', 'Cat');
  assert.equal(game.hostId, 'c');
});
