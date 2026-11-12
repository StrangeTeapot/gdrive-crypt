// Three-way sync: plan() is pure, apply() does the I/O.
import { T } from './i18n.ts';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry, RemoteFs } from './types.ts';

export type Action =
	| { type: 'upload'; path: string }
	| { type: 'download'; path: string }
	| { type: 'conflict'; path: string } // both changed (or both new w/o base): resolve during apply
	| { type: 'trashRemote'; path: string }
	| { type: 'trashLocal'; path: string }
	| { type: 'forget'; path: string } // deleted on both sides → drop from base
	| { type: 'adopt'; path: string; entry: BaseEntry }; // identical on both sides w/o base → record in base

export interface PlanOptions { minDeleteCount: number; maxDeletePct: number } // defaults 10 / 20
export interface Plan { actions: Action[]; blocked?: string; warnings: string[] }

const changed = (l: LocalEntry, b: BaseEntry) => Math.abs(l.mtime - b.mtime) > 2000 || l.size !== b.size;

function isSameFile(l: LocalEntry, r: RemoteEntry): boolean {
	const mtimeDiff = Math.abs(l.mtime - r.mtime);
	return l.size === r.size && mtimeDiff <= 2000;
}

export function plan(
	local: Map<string, LocalEntry>,
	remote: Map<string, RemoteEntry>,
	base: Map<string, BaseEntry>,
	opts: PlanOptions,
): Plan {
	const warnings: string[] = [];
	const actions: Action[] = [];
	const skip = new Set<string>();

	const canonical = (p: string) => p.normalize('NFC').toLowerCase();

	// 1. Group entries by canonical path for each side
	const groupByCanon = <T>(map: Map<string, T>) => {
		const byCanon = new Map<string, { path: string; entry: T }[]>();
		for (const [path, entry] of map.entries()) {
			const k = canonical(path);
			const list = byCanon.get(k) ?? [];
			list.push({ path, entry });
			byCanon.set(k, list);
		}
		return byCanon;
	};

	const localCanon = groupByCanon(local);
	const remoteCanon = groupByCanon(remote);

	// 2. Intra-side collision detection (multiple distinct files on the SAME side with same canonical name)
	for (const [, list] of localCanon.entries()) {
		if (list.length > 1) {
			const paths = list.map((item) => item.path);
			paths.forEach((p) => skip.add(p));
			warnings.push(T.caseCollisionLocal(paths.join(', ')));
		}
	}
	for (const [, list] of remoteCanon.entries()) {
		if (list.length > 1) {
			const paths = list.map((item) => item.path);
			paths.forEach((p) => skip.add(p));
			warnings.push(T.caseCollisionRemote(paths.join(', ')));
		}
	}

	// 3. Process canonical keys across local, remote, and base
	const allCanonKeys = new Set<string>([
		...localCanon.keys(),
		...remoteCanon.keys(),
		...Array.from(base.keys()).map(canonical),
	]);

	for (const k of allCanonKeys) {
		const lItem = localCanon.get(k)?.[0];
		const rItem = remoteCanon.get(k)?.[0];

		// Find all matching base entries for this canonical key
		const matchingBasePaths: string[] = [];
		for (const bp of base.keys()) {
			if (canonical(bp) === k) matchingBasePaths.push(bp);
		}

		const lPath = lItem?.path;
		const rPath = rItem?.path;

		// Clean up any stale duplicate base paths from previous case renames
		for (const bp of matchingBasePaths) {
			if (bp !== lPath && bp !== rPath) {
				actions.push({ type: 'forget', path: bp });
			}
		}

		const bPath = (lPath && base.has(lPath)) ? lPath : (rPath && base.has(rPath)) ? rPath : matchingBasePaths[0];
		const b = bPath ? base.get(bPath) : undefined;

		if (lItem && skip.has(lItem.path)) continue;
		if (rItem && skip.has(rItem.path)) continue;

		const l = lItem?.entry;
		const r = rItem?.entry;

		if (l && r) {
			// Both local and remote exist under this canonical key
			if (!b && isSameFile(l, r) && lPath === rPath) {
				// No base entry, but local and remote are identical within 2s ZIP tolerance: record baseline
				actions.push({ type: 'adopt', path: lPath!, entry: { mtime: l.mtime, size: l.size, md5: r.md5 } });
				continue;
			}

			const lc = !b || changed(l, b) || (bPath !== undefined && lPath !== bPath);
			const rc = !b || r.md5 !== b.md5 || (bPath !== undefined && rPath !== bPath);

			if (lc && rc && lPath !== rPath) {
				// Case mismatch and both modified -> conflict
				actions.push({ type: 'conflict', path: lPath! });
			} else if (lc || lPath !== rPath) {
				// Local changed or local has a new case -> upload local version and trash old remote case
				actions.push({ type: 'upload', path: lPath! });
				if (rPath && rPath !== lPath) {
					actions.push({ type: 'trashRemote', path: rPath });
				}
			} else if (rc) {
				// Remote changed -> download remote version
				actions.push({ type: 'download', path: rPath! });
			}
		} else if (l) {
			// Present locally, absent remotely
			const lc = !b || changed(l, b);
			if (!b || lc) {
				actions.push({ type: 'upload', path: lPath! });
			} else {
				actions.push({ type: 'trashLocal', path: lPath! });
			}
		} else if (r) {
			// Present remotely, absent locally
			const rc = !b || r.md5 !== b.md5;
			if (!b || rc) {
				actions.push({ type: 'download', path: rPath! });
			} else {
				actions.push({ type: 'trashRemote', path: rPath! });
			}
		} else if (bPath) {
			// Deleted on both sides
			actions.push({ type: 'forget', path: bPath });
		}
	}

	let blocked: string | undefined;
	const deletes = actions.filter((a) => a.type === 'trashRemote' || a.type === 'trashLocal').length;
	const limit = Math.max(opts.minDeleteCount, (opts.maxDeletePct / 100) * base.size);
	if (remote.size === 0 && base.size > 0) {
		blocked = T.blockedRemoteEmpty;
	} else if (deletes > limit) {
		blocked = T.blockedMassDelete(deletes, Math.floor(limit));
	}
	return { actions, blocked, warnings };
}

export interface ApplyHooks {
	deviceName: string; // for conflict file names
	now: () => Date;
	saveBase: (base: Map<string, BaseEntry>) => Promise<void>; // called after EVERY applied action
	onProgress?: (done: number, total: number, action: Action) => void;
	log?: (msg: string) => void;
}
export interface ApplyResult { done: number; conflicts: string[]; errors: { path: string; error: string }[] }

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const pad = (n: number) => String(n).padStart(2, '0');

export async function apply(
	p: Plan,
	local: LocalFs,
	remote: RemoteFs,
	base: Map<string, BaseEntry>,
	hooks: ApplyHooks,
): Promise<ApplyResult> {
	if (p.blocked) throw new Error(`Sync blocked: ${p.blocked}`);
	const res: ApplyResult = { done: 0, conflicts: [], errors: [] };

	const editedLocally = (l: LocalEntry | undefined, b: BaseEntry | undefined) => !!l && (!b || changed(l, b));

	const conflictName = async (path: string) => {
		const d = hooks.now();
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
		const slash = path.lastIndexOf('/') + 1;
		const dot = path.lastIndexOf('.');
		const cut = dot > slash ? dot : path.length;
		const stem = `${path.slice(0, cut)} (${T.conflictWord} ${hooks.deviceName.replace(/\//g, '-')} ${stamp})`;
		for (let n = 1; ; n++) {
			const name = `${stem}${n > 1 ? ` ${n}` : ''}${path.slice(cut)}`;
			if (!(await local.stat(name)) && !(await remote.stat(name))) return name;
		}
	};

	const conflict = async (path: string) => {
		const l = await local.stat(path);
		const r = await remote.stat(path);
		if (!l || !r) throw new Error(T.errVanished);
		const ld = await local.read(path);
		const rd = await remote.read(path);
		if (sameBytes(ld, rd)) {
			base.set(path, { mtime: l.mtime, size: l.size, md5: r.md5 });
			return;
		}
		const copy = await conflictName(path);
		const ce = await local.write(copy, rd, r.mtime);
		const cr = await remote.write(copy, rd, r.mtime);
		base.set(copy, { mtime: ce.mtime, size: ce.size, md5: cr.md5 });
		if ((await remote.stat(path))?.md5 !== r.md5) throw new Error(T.errChangedAgain);
		const w = await remote.write(path, ld, l.mtime);
		base.set(path, { mtime: l.mtime, size: l.size, md5: w.md5 });
		res.conflicts.push(copy);
		hooks.log?.(T.conflictLog(path, copy));
	};

	const run: Record<Action['type'], (path: string) => Promise<void>> = {
		upload: async (path) => {
			const l = await local.stat(path);
			if (!l) {
				base.delete(path);
				hooks.log?.(T.actionFailed('upload', path, T.errLocalVanished));
				return;
			}
			const r = await remote.stat(path);
			if (r && r.md5 !== base.get(path)?.md5) return conflict(path);
			const w = await remote.write(path, await local.read(path), l.mtime);
			base.set(path, { mtime: l.mtime, size: l.size, md5: w.md5 });
		},
		download: async (path) => {
			const r = await remote.stat(path);
			if (!r) {
				base.delete(path);
				hooks.log?.(T.actionFailed('download', path, T.errRemoteVanished));
				return;
			}
			const data = await remote.read(path);
			if (editedLocally(await local.stat(path), base.get(path))) return conflict(path);
			const e = await local.write(path, data, r.mtime);
			base.set(path, { mtime: e.mtime, size: e.size, md5: r.md5 });
		},
		conflict,
		trashRemote: async (path) => {
			const r = await remote.stat(path);
			const b = base.get(path);
			if (r && b && r.md5 !== b.md5) throw new Error(T.errRemoteChanged);
			if (r) await remote.trash(path);
			base.delete(path);
		},
		trashLocal: async (path) => {
			const l = await local.stat(path);
			const b = base.get(path);
			if (l && b && changed(l, b)) throw new Error(T.errLocalChanged);
			if (l) await local.trash(path);
			base.delete(path);
		},
		forget: async (path) => {
			base.delete(path);
		},
		adopt: async () => {},
	};

	let adopted = false;
	for (const a of p.actions) {
		if (a.type === 'adopt') {
			base.set(a.path, a.entry);
			adopted = true;
		}
	}
	if (adopted) {
		await hooks.saveBase(base);
	}

	const isDelete = (a: Action) => a.type === 'trashRemote' || a.type === 'trashLocal' || a.type === 'forget';
	const realActions = p.actions.filter((a) => a.type !== 'adopt');
	const queue = [...realActions.filter((a) => !isDelete(a)), ...realActions.filter(isDelete)];
	for (const [i, a] of queue.entries()) {
		try {
			await run[a.type](a.path);
			res.done++;
		} catch (e) {
			const error = e instanceof Error ? e.message : String(e);
			res.errors.push({ path: a.path, error });
			hooks.log?.(T.actionFailed(a.type, a.path, error));
		}
		await hooks.saveBase(base);
		hooks.onProgress?.(i + 1, queue.length, a);
	}
	return res;
}
