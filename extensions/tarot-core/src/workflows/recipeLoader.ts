/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Lucas Petrola — Tarot IDE. All rights reserved.
 *  Licensed under the GNU General Public License v3.0 (GPL-3.0). See LICENSE and NOTICE.md.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseYamlLite } from '../permissions/yamlLite';
import { validateWorkflow } from './recipeValidator';
import { LoadedRecipe, RecipeScope, WorkflowRecipe } from './workflowTypes';

export interface RecipeDiscoveryResult {
	readonly recipes: readonly LoadedRecipe[];
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

const RECIPE_FILE_RE = /^(.+)\.workflow\.(json|ya?ml)$/i;

/**
 * Discovers workflow recipes from workspace (`.tarot/workflows/`), user (`~/.tarot/workflows/`)
 * and bundled (`recipes/`). Precedence: workspace > user > bundled.
 * - An invalid higher-priority recipe reports an error and does NOT shadow a valid lower-priority one.
 * - When both `.workflow.json` and `.workflow.yaml`/`.yml` share a name in the same scope, JSON
 *   wins and a conflict warning is reported (MIGRATION_PLAN.md M3.9a).
 * Callers must gate workspace discovery on `vscode.workspace.isTrusted`.
 */
export class TarotRecipeLoader {
	constructor(private readonly bundledRecipesDir?: string) { }

	getUserWorkflowsDir(): string {
		return path.join(os.homedir(), '.tarot', 'workflows');
	}

	getWorkspaceWorkflowsDir(workspaceRoot: string): string {
		return path.join(workspaceRoot, '.tarot', 'workflows');
	}

	async discover(workspaceRoot?: string): Promise<RecipeDiscoveryResult> {
		const byName = new Map<string, LoadedRecipe>();
		const errors: string[] = [];
		const warnings: string[] = [];

		// Load lowest -> highest priority so valid higher-priority recipes overwrite lower ones,
		// while invalid higher-priority recipes never hide a valid lower-priority recipe.
		const scopes: Array<{ dir: string; scope: RecipeScope }> = [];
		if (this.bundledRecipesDir) {
			scopes.push({ dir: this.bundledRecipesDir, scope: 'bundled' });
		}
		scopes.push({ dir: this.getUserWorkflowsDir(), scope: 'user' });
		if (workspaceRoot) {
			scopes.push({ dir: this.getWorkspaceWorkflowsDir(workspaceRoot), scope: 'workspace' });
		}

		for (const { dir, scope } of scopes) {
			const res = await this.readScopeDir(dir, scope, workspaceRoot);
			errors.push(...res.errors);
			warnings.push(...res.warnings);
			for (const loaded of res.recipes) {
				byName.set(loaded.name.toLowerCase(), loaded);
			}
		}

		return {
			recipes: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
			errors,
			warnings,
		};
	}

	private async readScopeDir(dirPath: string, scope: RecipeScope, workspaceRoot?: string): Promise<RecipeDiscoveryResult> {
		let entries;
		try {
			entries = await fs.readdir(dirPath, { withFileTypes: true });
		} catch {
			return { recipes: [], errors: [], warnings: [] };
		}

		// Group files by stem so JSON wins over YAML when both exist in the same directory.
		const grouped = new Map<string, { json?: string; yaml?: string }>();
		for (const entry of entries) {
			if (!entry.isFile()) {
				continue;
			}
			const m = RECIPE_FILE_RE.exec(entry.name);
			if (!m) {
				continue;
			}
			const stem = m[1].toLowerCase();
			const ext = m[2].toLowerCase();
			const bucket = grouped.get(stem) ?? {};
			if (ext === 'json') {
				bucket.json = path.join(dirPath, entry.name);
			} else if (!bucket.yaml) {
				bucket.yaml = path.join(dirPath, entry.name);
			}
			grouped.set(stem, bucket);
		}

		const recipes: LoadedRecipe[] = [];
		const errors: string[] = [];
		const warnings: string[] = [];

		for (const [stem, files] of grouped) {
			if (files.json && files.yaml) {
				warnings.push(`Recipe "${stem}" has both JSON and YAML in ${scope}; JSON (${path.basename(files.json)}) wins.`);
			}
			const chosen = files.json ?? files.yaml!;
			try {
				const rawText = await fs.readFile(chosen, 'utf8');
				const parsed = chosen.toLowerCase().endsWith('.json')
					? JSON.parse(rawText) as WorkflowRecipe
					: parseYamlLite(rawText) as WorkflowRecipe;
				const validation = validateWorkflow(parsed, workspaceRoot);
				if (!validation.valid) {
					errors.push(`${chosen}: ${validation.errors.join(' ')}`);
					continue;
				}
				warnings.push(...validation.warnings.map(w => `${chosen}: ${w}`));
				recipes.push({
					name: parsed.name,
					scope,
					sourceFile: chosen,
					recipe: parsed,
				});
			} catch (err) {
				errors.push(`${chosen}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		return { recipes, errors, warnings };
	}
}
