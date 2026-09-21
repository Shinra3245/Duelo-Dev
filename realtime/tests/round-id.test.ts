import { describe, expect, it } from 'vitest';
import { playerRoundId, sharedRoundId } from '../src/gamemodes/round-id.js';

describe('identificadores UUID de rondas', () => {
  it('genera UUID estables distintos para rondas compartidas e individuales', () => {
    const sharedFirst = sharedRoundId('match-1', 0);
    const sharedNext = sharedRoundId('match-1', 1);
    const individual = playerRoundId('match-1', 'user-1', 0);
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    expect(sharedRoundId('match-1', 0)).toBe(sharedFirst);
    expect(new Set([sharedFirst, sharedNext, individual]).size).toBe(3);
    expect(
      [sharedFirst, sharedNext, individual].every((roundId) => uuidPattern.test(roundId)),
    ).toBe(true);
  });
});
