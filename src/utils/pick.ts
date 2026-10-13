/** Create an object composed of the picked object properties. */
const pick = <T extends object, K extends keyof T>(object: T | undefined, keys: readonly K[]): Pick<T, K> => {
  const picked = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) {
      picked[key] = object[key];
    }
  });
  return picked;
};

export default pick;
