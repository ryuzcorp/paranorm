import * as Effect from "effect/Effect";

/**
 * Run `tap` after a successful Effect value (e.g. publish a live-query snapshot).
 * Failures skip the tap.
 */
export const afterWrite = function afterWrite<A, E, R>(
  tap: (value: A) => void
): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> {
  return (effect) =>
    Effect.tap(effect, (value) => Effect.sync(() => tap(value)));
};
