import type { RequestUrlParam } from 'obsidian';
import type { Crypt } from './crypt.ts';
import { T } from './i18n.ts';
import type { RemoteEntry, RemoteFs } from './types.ts';

export type Request = (p: RequestUrlParam) => Promise<{
	status: number;
	json: unknown;
	arrayBuffer: ArrayBuffer;
	text: string;
	headers: Record<string, string>;
}>;

type Res = Awaited<ReturnType<Request>>;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));

const OAUTH = 'https://oauth2.googleapis.com';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json; charset=UTF-8';
const FOLDER = 'application/vnd.google-apps.folder';
const FIELDS = 'id,name,mimeType,size,md5Checksum,modifiedTime';
const MULTIPART_MAX = 5 * 1024 * 1024;

function body<T>(res: Res): T {
	try {
		return JSON.parse(res.text) as T;
	} catch {
		return {} as T;
	}
}

interface OAuthRes {
	error?: string;
	error_description?: string;
	refresh_token?: string;
	access_token?: string;
	expires_in?: number;
	user_code?: string;
	verification_url?: string;
	verification_uri?: string;
	device_code?: string;
	interval?: number;
}

interface ApiError {
	error?: { message?: string; errors?: { reason?: string }[] };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const buf = (u: Uint8Array): ArrayBuffer => {
	const b = u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
	return b instanceof ArrayBuffer ? b : new ArrayBuffer(0);
};

export interface DeviceLogin {
	userCode: string;
	verificationUrl: string;
	deviceCode: string;
	interval: number;
	expiresIn: number;
}

export async function startDeviceLogin(req: Request, clientId: string): Promise<DeviceLogin> {
	const res = await req({
		url: `${OAUTH}/device/code`,
		method: 'POST',
		contentType: FORM,
		body: form({ client_id: clientId, scope: SCOPE }),
		throw: false,
	});
	const j = body<OAuthRes>(res);
	if (res.status !== 200) throw new Error(`Google login ${res.status}: ${j.error_description ?? j.error ?? res.text}`);
	return {
		userCode: j.user_code ?? '',
		verificationUrl: j.verification_url ?? j.verification_uri ?? '',
		deviceCode: j.device_code ?? '',
		interval: j.interval ?? 5,
		expiresIn: j.expires_in ?? 0,
	};
}

export async function pollDeviceLogin(
	req: Request,
	clientId: string,
	clientSecret: string,
	login: DeviceLogin,
	signal?: AbortSignal,
	sleep = realSleep,
): Promise<string> {
	let interval = login.interval;
	for (;;) {
		await sleep(interval * 1000);
		if (signal?.aborted) throw new Error('Login cancelled');
		const res = await req({
			url: `${OAUTH}/token`,
			method: 'POST',
			contentType: FORM,
			throw: false,
			body: form({
				client_id: clientId,
				client_secret: clientSecret,
				device_code: login.deviceCode,
				grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
			}),
		});
		const j = body<OAuthRes>(res);
		if (res.status === 200 && j.refresh_token) return j.refresh_token;
		if (j.error === 'authorization_pending') continue;
		if (j.error === 'slow_down') {
			interval += 5;
			continue;
		}
		if (j.error === 'access_denied') throw new Error('Google login: access denied');
		if (j.error === 'expired_token') throw new Error('Google login: code expired, start again');
		throw new Error(`Google login ${res.status}: ${j.error_description ?? j.error ?? res.text}`);
	}
}

export function parseRefreshToken(s: string): string {
	try {
		return (JSON.parse(s) as OAuthRes).refresh_token ?? '';
	} catch {
		return s.trim();
	}
}

export class GoogleAuth {
	private req: Request;
	private clientId: string;
	private clientSecret: string;
	private refreshToken: string;
	private access?: { token: string; until: number };

	constructor(req: Request, clientId: string, clientSecret: string, refreshToken: string) {
		this.req = req;
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.refreshToken = refreshToken;
	}

	async token(): Promise<string> {
		if (!this.access || Date.now() > this.access.until - 60_000) {
			const res = await this.req({
				url: `${OAUTH}/token`,
				method: 'POST',
				contentType: FORM,
				throw: false,
				body: form({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					refresh_token: this.refreshToken,
					grant_type: 'refresh_token',
				}),
			});
			const j = body<OAuthRes>(res);
			if (res.status !== 200) {
				throw new Error(
					j.error === 'invalid_grant'
						? 'Google: login expired or revoked, log in again'
						: `Google token ${res.status}: ${j.error_description ?? j.error ?? res.text}`,
				);
			}
			this.access = { token: j.access_token ?? '', until: Date.now() + (j.expires_in ?? 3600) * 1000 };
		}
		return this.access.token;
	}

	invalidate(): void {
		this.access = undefined;
	}
}

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	md5Checksum?: string;
	modifiedTime: string;
}

export interface DriveChange {
	fileId: string;
	removed: boolean;
	file?: DriveFile & { parents?: string[]; trashed?: boolean };
}

const newer = (a: { mtime: number; id: string }, b: { mtime: number; id: string }) =>
	a.mtime > b.mtime || (a.mtime === b.mtime && a.id > b.id);

const newest = (fs: DriveFile[]) =>
	fs.reduce<DriveFile | undefined>(
		(a, f) =>
			!a || newer({ mtime: Date.parse(f.modifiedTime), id: f.id }, { mtime: Date.parse(a.modifiedTime), id: a.id })
				? f
				: a,
		undefined,
	);

function multipart(meta: object, data: Uint8Array, boundary: string): ArrayBuffer {
	const te = new TextEncoder();
	const head = te.encode(`--${boundary}\r\nContent-Type: ${JSON_TYPE}\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
	const tail = te.encode(`\r\n--${boundary}--\r\n`);
	const out = new Uint8Array(head.length + data.length + tail.length);
	out.set(head);
	out.set(data, head.length);
	out.set(tail, head.length + data.length);
	return out.buffer;
}

export class DriveClient {
	private req: Request;
	private auth: GoogleAuth;
	private sleep: Sleep;

	constructor(req: Request, auth: GoogleAuth, sleep = realSleep) {
		this.req = req;
		this.auth = auth;
		this.sleep = sleep;
	}

	async call(p: RequestUrlParam): Promise<Res> {
		let refreshed = false;
		for (let retries = 0; ; ) {
			const res = await this.req({
				...p,
				headers: { ...p.headers, Authorization: `Bearer ${await this.auth.token()}` },
				throw: false,
			});
			if (res.status >= 200 && res.status < 300) return res;
			if (res.status === 401 && !refreshed) {
				refreshed = true;
				this.auth.invalidate();
				continue;
			}
			const e = body<ApiError>(res).error;
			const reason = e?.errors?.[0]?.reason;
			const rate =
				res.status === 429 ||
				res.status >= 500 ||
				(res.status === 403 && (reason === 'userRateLimitExceeded' || reason === 'rateLimitExceeded'));
			if (rate && retries < 5) {
				await this.sleep(1000 * 2 ** retries++);
				continue;
			}
			throw Object.assign(new Error(`Google Drive ${res.status}: ${e?.message ?? res.text}`), { status: res.status });
		}
	}

	async list(parent: string, name?: string, folder?: boolean): Promise<DriveFile[]> {
		let q = `'${esc(parent)}' in parents and trashed=false`;
		if (name !== undefined) q += ` and name='${esc(name)}'`;
		if (folder !== undefined) q += ` and mimeType${folder ? '=' : '!='}'${FOLDER}'`;
		const out: DriveFile[] = [];
		let pageToken = '';
		do {
			const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: '1000' });
			if (pageToken) params.set('pageToken', pageToken);
			const j = body<{ files?: DriveFile[]; nextPageToken?: string }>(await this.call({ url: `${API}/files?${params}` }));
			out.push(...(j.files ?? []));
			pageToken = j.nextPageToken ?? '';
		} while (pageToken);
		return out;
	}

	async findChild(parent: string, name: string, folder: boolean): Promise<DriveFile | undefined> {
		return newest(await this.list(parent, name, folder));
	}

	async mkdir(parent: string, name: string): Promise<string> {
		const res = await this.call({
			url: `${API}/files?fields=id`,
			method: 'POST',
			contentType: JSON_TYPE,
			body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
		});
		return body<{ id: string }>(res).id;
	}

	async upload(data: Uint8Array, mtime: number, target: { id: string } | { parent: string; name: string }): Promise<DriveFile> {
		const modifiedTime = new Date(mtime).toISOString();
		const [url, method, meta] =
			'id' in target
				? [`${UPLOAD}/files/${target.id}`, 'PATCH', { modifiedTime }]
				: [`${UPLOAD}/files`, 'POST', { name: target.name, parents: [target.parent], modifiedTime }];

		if (data.byteLength <= MULTIPART_MAX) {
			const boundary = `cds${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
			const res = await this.call({
				url: `${url}?uploadType=multipart&fields=${FIELDS}`,
				method,
				contentType: `multipart/related; boundary=${boundary}`,
				body: multipart(meta, data, boundary),
			});
			return body<DriveFile>(res);
		}

		const init = await this.call({
			url: `${url}?uploadType=resumable&fields=${FIELDS}`,
			method,
			contentType: JSON_TYPE,
			body: JSON.stringify(meta),
		});
		const loc = Object.entries(init.headers).find(([k]) => k.toLowerCase() === 'location')?.[1];
		if (!loc) throw new Error('Google Drive: resumable upload returned no Location');
		return body<DriveFile>(await this.call({ url: loc, method: 'PUT', contentType: 'application/octet-stream', body: buf(data) }));
	}

	async get(id: string): Promise<(DriveFile & { parents: string[]; trashed: boolean }) | undefined> {
		try {
			return body<DriveFile & { parents: string[]; trashed: boolean }>(
				await this.call({ url: `${API}/files/${id}?fields=${FIELDS},parents,trashed` }),
			);
		} catch (e) {
			if ((e as { status?: number }).status === 404) return undefined;
			throw e;
		}
	}

	async download(id: string): Promise<Uint8Array> {
		return new Uint8Array((await this.call({ url: `${API}/files/${id}?alt=media` })).arrayBuffer);
	}

	async move(id: string, from: string, to: string, name?: string): Promise<void> {
		await this.call({
			url: `${API}/files/${id}?addParents=${to}&removeParents=${from}&fields=id`,
			method: 'PATCH',
			contentType: JSON_TYPE,
			body: JSON.stringify(name ? { name } : {}),
		});
	}

	async getStartPageToken(): Promise<string> {
		const res = await this.call({ url: `${API}/changes/startPageToken` });
		return body<{ startPageToken: string }>(res).startPageToken;
	}

	async listChanges(pageToken: string): Promise<{ changes: DriveChange[]; newStartPageToken?: string }> {
		const changes: DriveChange[] = [];
		let curToken = pageToken;
		let newStartPageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				pageToken: curToken,
				fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS},parents,trashed))`,
				pageSize: '1000',
				supportsAllDrives: 'true',
			});
			const res = await this.call({ url: `${API}/changes?${params}` });
			const j = body<{ changes?: DriveChange[]; nextPageToken?: string; newStartPageToken?: string }>(res);
			if (j.changes) changes.push(...j.changes);
			if (j.newStartPageToken) newStartPageToken = j.newStartPageToken;
			curToken = j.nextPageToken ?? '';
		} while (curToken);
		return { changes, newStartPageToken };
	}
}

export class RootMissingError extends Error {
	constructor(root: string) {
		super(T.rootMissing(root));
	}
}

export interface CryptDriveConfig {
	rootPath: string;
	folder: string;
	trashDir: string;
	createRoot?: boolean;
	dirNameEncrypt?: boolean;
}

type CryptLike = Pick<Crypt, 'encryptPath' | 'decryptPath' | 'encryptData' | 'decryptData'>;

function today(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface CachedRemoteFile {
	id: string;
	parent: string;
	md5: string;
	mtime: number;
	size: number;
}

export class CryptDriveFs implements RemoteFs {
	private drive: DriveClient;
	private crypt: CryptLike;
	private cfg: CryptDriveConfig;
	private decryptedSize: (encSize: number) => number;
	private dirs = new Map<string, string>();
	private files = new Map<string, CachedRemoteFile>();
	private folderIdToPath = new Map<string, string>(); // Maps folder ID -> encrypted relative path ("" for vault root)
	private listed = false;
	private pendingFolderCleanup = new Set<string>();
	private pageToken?: string;

	constructor(
		drive: DriveClient,
		crypt: CryptLike,
		cfg: CryptDriveConfig,
		decryptedSize: (encSize: number) => number,
		pageToken?: string,
		initialFiles?: Map<string, CachedRemoteFile>,
	) {

		
		const norm = (p: string) => p.split('/').filter(Boolean).join('/');
		this.drive = drive;
		this.crypt = crypt;
		this.decryptedSize = decryptedSize;
		this.cfg = {
			rootPath: norm(cfg.rootPath),
			folder: norm(cfg.folder),
			trashDir: norm(cfg.trashDir),
			createRoot: cfg.createRoot,
			dirNameEncrypt: cfg.dirNameEncrypt,
		};
		this.pageToken = pageToken;
		if (initialFiles) {
			this.files = new Map(initialFiles);
		}
	}

	getFilesCache(): Map<string, CachedRemoteFile> {
		return new Map(this.files);
	}

	getPageToken(): string | undefined {
		return this.pageToken;
	}

	private async getProtectedFolderIds(): Promise<Set<string>> {
		const protectedIds = new Set<string>(['root']);
		const rootId = await this.dirId(this.cfg.rootPath.split('/').filter(Boolean), false);
		if (rootId) protectedIds.add(rootId);
		const topId = await this.dirId(this.loc('_').dir, false);
		if (topId) protectedIds.add(topId);
		return protectedIds;
	}

	async cleanEmptyRemoteFolders(): Promise<void> {
		const protectedIds = await this.getProtectedFolderIds();

		if (this.pendingFolderCleanup.size > 0) {
			const targets = Array.from(this.pendingFolderCleanup);
			this.pendingFolderCleanup.clear();
			for (const folderId of targets) {
				await this.pruneFolderIfEmpty(folderId, protectedIds);
			}
		}

		// Also sweep any empty vault folders discovered during a full listing (e.g., Reconcile or cross-device deletes)
		if (this.listed && this.folderIdToPath.size > 0) {
			const candidates: { id: string; depth: number }[] = [];
			for (const [folderId, encRel] of this.folderIdToPath.entries()) {
				if (!encRel || protectedIds.has(folderId)) continue;
				candidates.push({ id: folderId, depth: encRel.split('/').length });
			}
			candidates.sort((a, b) => b.depth - a.depth);
			for (const candidate of candidates) {
				if (!this.folderIdToPath.has(candidate.id)) continue;
				await this.pruneFolderIfEmpty(candidate.id, protectedIds);
			}
		}
	}

	async purgeEmptySubfoldersForSubpaths(subpaths: string[]): Promise<number> {
		if (!subpaths.length || this.folderIdToPath.size === 0) return 0;
		const protectedIds = await this.getProtectedFolderIds();
		const candidates: { id: string; depth: number }[] = [];

		for (const [folderId, encRel] of this.folderIdToPath.entries()) {
			if (!encRel || protectedIds.has(folderId)) continue;
			let decPath: string;
			try {
				decPath = (this.cfg.dirNameEncrypt === false ? encRel : this.crypt.decryptPath(encRel)).normalize('NFC');
			} catch {
				continue;
			}
			if (
				subpaths.some(
					(sub) =>
						decPath === sub ||
						decPath.startsWith(`${sub}/`) ||
						decPath.endsWith(`/${sub}`) ||
						decPath.includes(`/${sub}/`),
				)
			) {
				candidates.push({ id: folderId, depth: decPath.split('/').length });
			}
		}

		candidates.sort((a, b) => b.depth - a.depth);
		let removed = 0;
		for (const candidate of candidates) {
			if (!this.folderIdToPath.has(candidate.id)) continue;
			if (await this.pruneFolderIfEmpty(candidate.id, protectedIds)) {
				removed++;
			}
		}
		return removed;
	}

	private async pruneFolderIfEmpty(folderId: string, protectedIds: Set<string>): Promise<boolean> {
		if (!folderId || protectedIds.has(folderId)) return false;
		const children = await this.drive.list(folderId);
		if (children.length === 0) {
			const folderMeta = await this.drive.get(folderId);
			const parentId = folderMeta?.parents?.[0];
			await this.drive.call({
				url: `${API}/files/${folderId}`,
				method: 'PATCH',
				contentType: JSON_TYPE,
				body: JSON.stringify({ trashed: true }),
			});

			// Evict trashed folder from internal directory caches
			for (const [key, id] of this.dirs.entries()) {
				if (id === folderId) {
					this.dirs.delete(key);
					break;
				}
			}
			this.folderIdToPath.delete(folderId);

			if (parentId && !protectedIds.has(parentId)) {
				await this.pruneFolderIfEmpty(parentId, protectedIds);
			}
			return true;
		}
		return false;
	}

async list(): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }> {
		if (this.pageToken && this.files.size > 0) {
			try {
				return await this.listIncremental(this.pageToken);
			} catch {
				// Fallback to full list if incremental token has expired or is invalid
			}
		}
		return await this.listFull();
	}

private async listFull(): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }> {
		this.dirs.clear();
		this.files.clear();
		this.folderIdToPath.clear();
		this.listed = false;
		const files = new Map<string, RemoteEntry>();
		const warnings: string[] = [];

		let newToken: string | undefined;
		try {
			newToken = await this.drive.getStartPageToken();
		} catch {
			// Ignore token fetch failure
		}

		const root = this.cfg.rootPath.split('/').filter(Boolean);
		const top = this.loc('_').dir;

		let rootId = await this.dirId(root, false);
		if (!rootId) {
if (this.cfg.createRoot) {
				await this.dirId(top, true);
				rootId = await this.dirId(root, false);
				if (!rootId) {
					throw new RootMissingError(this.cfg.rootPath);
				}
			} else {
				throw new RootMissingError(this.cfg.rootPath);
			}
		}

		const children = this.cfg.dirNameEncrypt === false ? [] : await this.drive.list(rootId);
		if (
			children.length &&
			!children.some((c) => {
				try {
					this.crypt.decryptPath(c.name);
					return true;
				} catch {
					return false;
				}
			})
		) {
			throw new Error("can't decrypt names in the crypt root — wrong password, salt or folder-name encryption setting");
		}

		const id = await this.dirId(top, false);
		if (id) {
			this.folderIdToPath.set(id, '');
			await this.walk(id, '', [], files, warnings);
		}
		this.listed = true;
		this.pageToken = newToken;
		return { files, warnings };
	}

	private async listIncremental(token: string): Promise<{ files: Map<string, RemoteEntry>; warnings: string[] }> {
		const { changes, newStartPageToken } = await this.drive.listChanges(token);
		const warnings: string[] = [];

		const top = this.loc('_').dir;
		const topId = await this.dirId(top, false);

		if (!topId) {
			return await this.listFull();
		}
		this.folderIdToPath.set(topId, '');

		const findPathByFileId = (fileId: string): string | undefined => {
			for (const [path, entry] of this.files.entries()) {
				if (entry.id === fileId) return path;
			}
			return undefined;
		};

		const outsideVaultIds = new Set<string>(['root']);

        const resolveParentEncPath = async (parentId?: string): Promise<string | null> => {
			if (!parentId || outsideVaultIds.has(parentId)) return null;
			if (parentId === topId) return '';
			if (this.folderIdToPath.has(parentId)) return this.folderIdToPath.get(parentId)!;

			let currId = parentId;
			const chain: { id: string; name: string }[] = [];

			while (currId && currId !== topId && !outsideVaultIds.has(currId) && !this.folderIdToPath.has(currId)) {
				const meta = await this.drive.get(currId);
				if (!meta || meta.trashed || !meta.parents?.[0]) {
					for (const seg of chain) outsideVaultIds.add(seg.id);
					if (currId) outsideVaultIds.add(currId);
					return null;
				}
				chain.unshift({ id: currId, name: meta.name });
				currId = meta.parents[0];
			}

			if (currId !== topId && !this.folderIdToPath.has(currId)) {
				for (const seg of chain) outsideVaultIds.add(seg.id);
				if (currId) outsideVaultIds.add(currId);
				return null;
			}

			let accum = currId === topId ? '' : (this.folderIdToPath.get(currId) ?? '');
			for (const seg of chain) {
				accum = accum ? `${accum}/${seg.name}` : seg.name;
				this.folderIdToPath.set(seg.id, accum);
			}
			return accum;
		};

		for (const change of changes) {
			const oldPath = findPathByFileId(change.fileId);

			if (change.removed || change.file?.trashed) {
				if (oldPath) this.files.delete(oldPath);
				continue;
			}

			if (change.file) {
				const f = change.file;

				if (f.mimeType === FOLDER) {
					if (f.parents?.[0]) {
						const parentEnc = await resolveParentEncPath(f.parents[0]);
						if (parentEnc !== null) {
							this.folderIdToPath.set(f.id, parentEnc ? `${parentEnc}/${f.name}` : f.name);
						}
					}
					continue;
				}

				if (f.mimeType?.startsWith('application/vnd.google-apps.')) continue;

				const parentId = f.parents?.[0];
				const parentEncPath = await resolveParentEncPath(parentId);

				// File moved outside vault root (e.g. to _deleted/) -> delete from active index
				if (parentEncPath === null) {
					if (oldPath) this.files.delete(oldPath);
					continue;
				}

				const fullEncPath = parentEncPath ? `${parentEncPath}/${f.name}` : f.name;

				try {
					let path: string;
					if (this.cfg.dirNameEncrypt === false) {
						path = fullEncPath.normalize('NFC');
					} else {
						path = this.crypt.decryptPath(fullEncPath).normalize('NFC');
					}

					if (oldPath && oldPath !== path) {
						this.files.delete(oldPath);
					}

					this.files.set(path, {
						id: f.id,
						parent: parentId ?? '',
						md5: f.md5Checksum ?? '',
						mtime: Date.parse(f.modifiedTime),
						size: this.decryptedSize(Number(f.size ?? 0)),
					});
				} catch {
					// Skip un-decryptable or foreign files
				}
			}
		}

		const files = new Map<string, RemoteEntry>();
		for (const [path, ref] of this.files.entries()) {
			files.set(path, { id: ref.id, md5: ref.md5, mtime: ref.mtime, size: ref.size });
		}

		if (newStartPageToken) this.pageToken = newStartPageToken;
		this.listed = true;
		return { files, warnings };
	}

	private async walk(
		id: string,
		encRel: string,
		chain: string[],
		out: Map<string, RemoteEntry>,
		warnings: string[],
	): Promise<void> {
		for (const f of await this.drive.list(id)) {
			const rel = encRel ? `${encRel}/${f.name}` : f.name;
			if (f.mimeType === FOLDER) {
				this.folderIdToPath.set(f.id, rel);
				await this.walk(f.id, rel, [...chain, f.id], out, warnings);
				continue;
			}
			if (f.mimeType.startsWith('application/vnd.google-apps.')) continue;
			let path: string;
			try {
				path = this.crypt.decryptPath(rel).normalize('NFC');
			} catch {
				throw new Error("can't decrypt names — wrong password or foreign files in folder");
			}
			const dir = this.loc(path).dir;
			chain.forEach((cid, i) => this.dirs.set(dir.slice(0, dir.length - chain.length + i + 1).join('/'), cid));
			const e = this.entry(f);
			const old = out.get(path);
			if (old) {
				warnings.push(T.duplicate(path));
				if (!newer(e, old)) continue;
			}
			out.set(path, e);
			this.files.set(path, { id: f.id, parent: id, md5: e.md5, mtime: e.mtime, size: e.size });
		}
	}

	async stat(path: string): Promise<RemoteEntry | undefined> {
		const f = (await this.find(path))?.f;
		return f && this.entry(f);
	}

	async read(path: string): Promise<Uint8Array> {
		const id = (this.files.get(path) ?? (await this.find(path)))?.id;
		if (!id) throw new Error(`Not on Drive: ${path}`);
		return this.crypt.decryptData(await this.drive.download(id));
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<RemoteEntry> {
		const { dir, name } = this.loc(path);
		const parent = (await this.dirId(dir, true))!;
		const id = this.files.get(path)?.id ?? (this.listed ? undefined : (await this.drive.findChild(parent, name, false))?.id);
		const f = await this.drive.upload(this.crypt.encryptData(data), mtime, id ? { id } : { parent, name });
		const entry = this.entry(f);
		this.files.set(path, { id: f.id, parent, md5: entry.md5, mtime: entry.mtime, size: entry.size });
		return this.entry(f);
	}

	async trash(path: string): Promise<void> {
		const known = await this.find(path);
		if (!known) return;
		this.pendingFolderCleanup.add(known.parent);
		if (!this.cfg.trashDir) {
			await this.drive.call({
				url: `${API}/files/${known.id}`,
				method: 'PATCH',
				contentType: JSON_TYPE,
				body: JSON.stringify({ trashed: true }),
			});
			this.files.delete(path);
			return;
		}
		const prefix = `${this.cfg.trashDir}/${today()}/${this.cfg.folder}`;
		const target = this.loc(path, prefix);
		const to = (await this.dirId(target.dir, true))!;
		let name: string | undefined;
		if (await this.drive.findChild(to, target.name, false)) {
			const d = new Date();
			const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
			const slash = path.lastIndexOf('/') + 1;
			const dot = path.lastIndexOf('.');
			const cut = dot > slash ? dot : path.length;
			name = this.loc(`${path.slice(0, cut)} ${t}${path.slice(cut)}`, prefix).name;
		}
		await this.drive.move(known.id, known.parent, to, name);
		this.files.delete(path);
	}

	private loc(path: string, prefix = this.cfg.folder): { dir: string[]; name: string } {
		const enc = this.crypt.encryptPath(`${prefix}/${path}`).split('/');
		return { dir: [...this.cfg.rootPath.split('/').filter(Boolean), ...enc.slice(0, -1)], name: enc[enc.length - 1]! };
	}

	private async find(path: string): Promise<{ id: string; parent: string; f: DriveFile } | undefined> {
		const known = this.files.get(path);
		if (known) {
			const f = await this.drive.get(known.id);
			if (f && !f.trashed && f.parents.includes(known.parent)) return { ...known, f };
			this.files.delete(path);
		}
		const { dir, name } = this.loc(path);
		const parent = await this.dirId(dir, false);
		const f = parent ? await this.drive.findChild(parent, name, false) : undefined;
		if (!parent || !f) return undefined;
		const entry = this.entry(f);
		this.files.set(path, { id: f.id, parent, md5: entry.md5, mtime: entry.mtime, size: entry.size });
		return { id: f.id, parent, f };
	}

    private async dirId(names: string[], create: boolean): Promise<string | undefined> {
		let id = 'root';
		for (let i = 0; i < names.length; i++) {
			const key = names.slice(0, i + 1).join('/');
			let next = this.dirs.get(key);
			if (!next) {
				next = (await this.drive.findChild(id, names[i]!, true))?.id;
				if (!next) {
					if (!create) return undefined;
					next = await this.drive.mkdir(id, names[i]!);
				}
				this.dirs.set(key, next);
			}
			id = next;
		}
		return id;
	}

	private entry(f: DriveFile): RemoteEntry {
		return { id: f.id, md5: f.md5Checksum ?? '', mtime: Date.parse(f.modifiedTime), size: this.decryptedSize(Number(f.size ?? 0)) };
	}
}
