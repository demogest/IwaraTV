import { useRef } from "react";

/** Returns `value` while `active`, otherwise the last value seen while active. */
export function useFrozenWhileHidden<T>(value: T, active: boolean): T {
  const frozen = useRef(value);
  if (active) {
    frozen.current = value;
  }
  return frozen.current;
}
