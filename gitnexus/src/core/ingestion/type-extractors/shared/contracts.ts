/** Which type argument to extract from a multi-arg generic container.
 *  - 'first': key type (e.g., K from Map<K,V>) — used for .keys(), .keySet()
 *  - 'last':  value type (e.g., V from Map<K,V>) — used for .values(), .items(), .iter() */
export type TypeArgPosition = "first" | "last";
