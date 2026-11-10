// A promise-chain mutex: callbacks run one at a time, in call order, whether or not an earlier one threw.
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(() => fn());
    tail = result.catch(() => {});
    return result;
  };
}
