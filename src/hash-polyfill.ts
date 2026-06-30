const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

type XxHashInput = string | ArrayBuffer | ArrayBufferView;

function toBytes(input: XxHashInput): Uint8Array {
	if (typeof input === "string") return new TextEncoder().encode(input);
	if (input instanceof ArrayBuffer) return new Uint8Array(input);
	return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function rotateLeft(value: number, bits: number): number {
	return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (
		bytes[offset]! |
		(bytes[offset + 1]! << 8) |
		(bytes[offset + 2]! << 16) |
		(bytes[offset + 3]! << 24)
	) >>> 0;
}

function round(accumulator: number, input: number): number {
	let acc = (accumulator + Math.imul(input, PRIME32_2)) >>> 0;
	acc = rotateLeft(acc, 13);
	acc = Math.imul(acc, PRIME32_1) >>> 0;
	return acc;
}

export function xxHash32(input: XxHashInput, seed = 0): number {
	const bytes = toBytes(input);
	const length = bytes.length;
	let offset = 0;
	let hash: number;
	const unsignedSeed = seed >>> 0;

	if (length >= 16) {
		const limit = length - 16;
		let v1 = (unsignedSeed + PRIME32_1 + PRIME32_2) >>> 0;
		let v2 = (unsignedSeed + PRIME32_2) >>> 0;
		let v3 = unsignedSeed;
		let v4 = (unsignedSeed - PRIME32_1) >>> 0;

		while (offset <= limit) {
			v1 = round(v1, readUint32LE(bytes, offset));
			offset += 4;
			v2 = round(v2, readUint32LE(bytes, offset));
			offset += 4;
			v3 = round(v3, readUint32LE(bytes, offset));
			offset += 4;
			v4 = round(v4, readUint32LE(bytes, offset));
			offset += 4;
		}

		hash = (
			rotateLeft(v1, 1) +
			rotateLeft(v2, 7) +
			rotateLeft(v3, 12) +
			rotateLeft(v4, 18)
		) >>> 0;
	} else {
		hash = (unsignedSeed + PRIME32_5) >>> 0;
	}

	hash = (hash + length) >>> 0;

	while (offset <= length - 4) {
		hash = (hash + Math.imul(readUint32LE(bytes, offset), PRIME32_3)) >>> 0;
		hash = rotateLeft(hash, 17);
		hash = Math.imul(hash, PRIME32_4) >>> 0;
		offset += 4;
	}

	while (offset < length) {
		hash = (hash + Math.imul(bytes[offset]!, PRIME32_5)) >>> 0;
		hash = rotateLeft(hash, 11);
		hash = Math.imul(hash, PRIME32_1) >>> 0;
		offset++;
	}

	hash ^= hash >>> 15;
	hash = Math.imul(hash, PRIME32_2) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, PRIME32_3) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

export function installBunHashPolyfill(): void {
	const globalWithBun = globalThis as typeof globalThis & {
		Bun?: { hash?: { xxHash32?: (input: XxHashInput, seed?: number) => number } };
	};
	if (typeof globalWithBun.Bun?.hash?.xxHash32 === "function") return;

	const bun = globalWithBun.Bun ?? {};
	bun.hash = { ...bun.hash, xxHash32 };
	globalWithBun.Bun = bun;
}

installBunHashPolyfill();
