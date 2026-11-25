/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure local Hybrid Search engine (BM25 + hashed character 3-gram cosine vector similarity
 * combined via Reciprocal Rank Fusion) for Tarot Crew's Knowledge Library.
 * Zero native dependencies, deterministic, and unit-testable.
 */

const VECTOR_DIMS = 128;

export interface IndexedTextDoc {
	readonly id: string;
	readonly text: string;
	readonly tokens: readonly string[];
}

export interface HybridSearchScore {
	readonly id: string;
	readonly score: number;
	readonly bm25: number;
	readonly cosine: number;
}

export function normalizeForSearch(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '');
}

export function tokenizeForSearch(text: string): string[] {
	return normalizeForSearch(text)
		.replace(/[^a-z0-9_-]+/g, ' ')
		.split(/\s+/)
		.filter(t => t.length >= 2);
}

function fnv1aHash(str: string): number {
	let hash = 2166136261;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** Projects text into a normalized 128-dim signed feature vector using word tokens + char 3-grams. */
export function computeLocalEmbedding(text: string): Float32Array {
	const vec = new Float32Array(VECTOR_DIMS);
	const norm = normalizeForSearch(text).replace(/\s+/g, ' ').trim();
	if (!norm) {
		return vec;
	}

	// Word unigrams
	for (const tok of tokenizeForSearch(norm)) {
		const h = fnv1aHash(`w:${tok}`);
		const idx = h % VECTOR_DIMS;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[idx] += sign * 1.5;
	}

	// Character 3-grams (captures morphological inflection & partial code identifiers)
	const padded = ` ${norm.slice(0, 2000)} `;
	for (let i = 0; i <= padded.length - 3; i++) {
		const gram = padded.slice(i, i + 3);
		const h = fnv1aHash(`g:${gram}`);
		const idx = h % VECTOR_DIMS;
		const sign = (h & 1) === 0 ? 1 : -1;
		vec[idx] += sign * 1.0;
	}

	let magSq = 0;
	for (let i = 0; i < VECTOR_DIMS; i++) {
		magSq += vec[i] * vec[i];
	}
	const mag = Math.sqrt(magSq);
	if (mag > 0) {
		for (let i = 0; i < VECTOR_DIMS; i++) {
			vec[i] /= mag;
		}
	}
	return vec;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		dot += a[i] * b[i];
	}
	return dot;
}

/**
 * Ranks documents against `query` using Hybrid BM25 + Local Embedding Cosine Similarity
 * fused via Reciprocal Rank Fusion (RRF, k = 60).
 */
export function hybridRankDocuments(
	docs: readonly IndexedTextDoc[],
	query: string,
	topK = 5,
): HybridSearchScore[] {
	if (docs.length === 0) {
		return [];
	}
	const queryTokens = tokenizeForSearch(query);
	if (queryTokens.length === 0) {
		return [];
	}

	// 1. BM25 statistics
	const docFreq = new Map<string, number>();
	let totalLen = 0;
	const docTermCounts: Array<Map<string, number>> = [];

	for (const doc of docs) {
		totalLen += doc.tokens.length;
		const counts = new Map<string, number>();
		for (const t of doc.tokens) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		docTermCounts.push(counts);
		for (const term of counts.keys()) {
			docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
		}
	}
	const avgDocLen = totalLen / docs.length || 1;
	const k1 = 1.5;
	const b = 0.75;
	const N = docs.length;

	const queryVec = computeLocalEmbedding(query);

	const bm25Scores: Array<{ idx: number; score: number }> = [];
	const cosineScores: Array<{ idx: number; score: number }> = [];

	for (let i = 0; i < docs.length; i++) {
		const counts = docTermCounts[i];
		const docLen = docs[i].tokens.length || 1;
		let bm25 = 0;
		for (const qt of queryTokens) {
			const tf = counts.get(qt) ?? 0;
			if (tf === 0) {
				continue;
			}
			const df = docFreq.get(qt) ?? 0;
			const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
			bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen))));
		}
		bm25Scores.push({ idx: i, score: bm25 });

		const docVec = computeLocalEmbedding(docs[i].text);
		const cos = Math.max(0, cosineSimilarity(queryVec, docVec));
		cosineScores.push({ idx: i, score: cos });
	}

	const bm25Rank = new Map<number, number>();
	[...bm25Scores].sort((a, b) => b.score - a.score).forEach((entry, rank) => {
		if (entry.score > 0) {
			bm25Rank.set(entry.idx, rank + 1);
		}
	});

	const cosRank = new Map<number, number>();
	[...cosineScores].sort((a, b) => b.score - a.score).forEach((entry, rank) => {
		if (entry.score > 0.12) {
			cosRank.set(entry.idx, rank + 1);
		}
	});

	const rrfK = 60;
	const results: HybridSearchScore[] = [];
	for (let i = 0; i < docs.length; i++) {
		const rB = bm25Rank.get(i);
		const rC = cosRank.get(i);
		if (rB === undefined && rC === undefined) {
			continue;
		}
		const rrf = (rB !== undefined ? 1 / (rrfK + rB) : 0) + (rC !== undefined ? 1 / (rrfK + rC) : 0);
		results.push({
			id: docs[i].id,
			score: rrf,
			bm25: bm25Scores[i].score,
			cosine: cosineScores[i].score,
		});
	}

	return results.sort((a, b) => b.score - a.score).slice(0, topK);
}
