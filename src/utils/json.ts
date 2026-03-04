/**
 * Safely converts an object to a JSON-serializable structure, handling BigInt values by converting them to strings.
 * This prevents TypeError: Do not know how to serialize a BigInt.
 * @param data The data to be serialized.
 * @returns A JSON-serializable copy of the data.
 */
export function safeJSON(data: any): any {
    return JSON.parse(JSON.stringify(data, (key, value) =>
        typeof value === 'bigint' ? value.toString() : value
    ));
}
