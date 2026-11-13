import { Modal, Notice, Platform, Plugin, Setting, TFile, getLanguage, normalizePath, requestUrl, setIcon, setTooltip } from 'obsidian';
import type { App } from 'obsidian';
import { Crypt } from './crypt';
import { CryptDriveFs, DriveClient, GoogleAuth, RootMissingError, parseRefreshToken, pollDeviceLogin, startDeviceLogin } from './drive';
import type { CachedRemoteFile, Request } from './drive';
import { T, setLanguage } from './i18n';
import { CryptDriveSyncSettingTab, DEFAULTS } from './settings';
import type { Settings } from './settings';
import { apply, plan } from './sync';
import type { Action, Plan } from './sync';
import type { BaseEntry, LocalEntry, LocalFs, RemoteEntry } from './types';
import { SetupWizard } from './wizard';
import { BackupManager, RemoteBackupsModal } from './backup';
import { PathSanitizer } from './sanitizer';

const TOKEN_ID = 'token';
export const PASSWORD_ID = 'password';
export const SALT_ID = 'salt';
export const CLIENT_SECRET_ID = 'client-secret';

declare const GOOGLE_CLIENT: { id: string; secret: string };

const MIN_DELETE_COUNT = 10;
const req = requestUrl as unknown as Request;

interface PayloadData {
	v?: number;
	s?: {
		ci?: string;
		r?: string;
		f?: string;
		e?: boolean;
		t?: string;
	};
	sec?: {
		p?: string;
		s?: string;
		cs?: string;
		tk?: string;
	};
	settings?: Partial<Settings>;
	secrets?: {
		password?: string;
		salt?: string;
		clientSecret?: string;
		token?: string;
	};
}

function encodePayloadBase64Url(rawJson: string): string {
	const bytes = new TextEncoder().encode(rawJson);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodePayloadBase64Url(encoded: string): string {
	const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
	const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new TextDecoder().decode(bytes);
}

// Self-contained ISO/IEC 18004 Byte-Mode QR encoder (Versions 1..20, EC Level L) — 100% offline.
const QR_VERSION_EC_L: ReadonlyArray<readonly [number, number, number, number, number] | null> = [
	null,
	[26, 1, 19, 0, 0],
	[44, 1, 34, 0, 0],
	[70, 1, 55, 0, 0],
	[100, 1, 80, 0, 0],
	[134, 1, 108, 0, 0],
	[172, 2, 68, 0, 0],
	[196, 2, 78, 0, 0],
	[242, 2, 97, 0, 0],
	[292, 2, 116, 0, 0],
	[346, 2, 68, 2, 69],
	[404, 4, 81, 0, 0],
	[466, 2, 92, 2, 93],
	[532, 4, 107, 0, 0],
	[581, 3, 115, 1, 116],
	[655, 5, 87, 1, 88],
	[733, 5, 98, 1, 99],
	[815, 1, 107, 5, 108],
	[901, 5, 120, 1, 121],
	[991, 3, 113, 4, 114],
	[1085, 3, 107, 5, 108],
];

const QR_ALIGNMENT: ReadonlyArray<readonly number[]> = [
	[],
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
	[6, 30, 54],
	[6, 32, 58],
	[6, 34, 62],
	[6, 26, 46, 66],
	[6, 26, 48, 70],
	[6, 26, 50, 74],
	[6, 30, 54, 78],
	[6, 30, 56, 82],
	[6, 30, 58, 86],
	[6, 34, 62, 90],
];

function gfMul(x: number, y: number): number {
	let r = 0;
	let a = x;
	let b = y;
	while (b > 0) {
		if (b & 1) r ^= a;
		b >>= 1;
		a <<= 1;
		if (a & 0x100) a ^= 0x11d;
	}
	return r;
}

function rsDivisor(degree: number): number[] {
	let result = [1];
	for (let i = 0; i < degree; i++) {
		const next = new Array<number>(result.length + 1).fill(0);
		let root = 1;
		for (let k = 0; k < i; k++) root = gfMul(root, 2);
		for (let j = 0; j < result.length; j++) {
			const coeff = result[j]!;
			next[j] = next[j]! ^ coeff;
			next[j + 1] = next[j + 1]! ^ gfMul(coeff, root);
		}
		result = next;
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const rem = new Array<number>(divisor.length - 1).fill(0);
	for (const b of data) {
		const factor = b ^ rem[0]!;
		rem.shift();
		rem.push(0);
		for (let i = 0; i < rem.length; i++) {
			rem[i] = rem[i]! ^ gfMul(divisor[i + 1]!, factor);
		}
	}
	return rem;
}

function buildQrMatrix(text: string): boolean[][] {
	const raw = new TextEncoder().encode(text);
	let version = 0;
	for (let v = 1; v <= 20; v++) {
		const spec = QR_VERSION_EC_L[v]!;
		const totalDataCw = spec[1] * spec[2] + spec[3] * spec[4];
		const ccBits = v <= 9 ? 8 : 16;
		if (4 + ccBits + 8 * raw.length <= totalDataCw * 8) {
			version = v;
			break;
		}
	}
	if (!version) throw new Error('Configuration payload is too large for QR code.');

	const [tot, b1, d1, b2, d2] = QR_VERSION_EC_L[version]!;
	const totalDataCw = b1 * d1 + b2 * d2;
	const ecCwPerBlock = Math.floor((tot - totalDataCw) / (b1 + b2));

	const bits: number[] = [];
	const pushBits = (val: number, len: number) => {
		for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
	};

	pushBits(0b0100, 4);
	pushBits(raw.length, version <= 9 ? 8 : 16);
	for (let i = 0; i < raw.length; i++) pushBits(raw[i]!, 8);
	pushBits(0, Math.min(4, totalDataCw * 8 - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);

	const dataCw: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let val = 0;
		for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j]!;
		dataCw.push(val);
	}
	const padBytes = [0xec, 0x11];
	let padIdx = 0;
	while (dataCw.length < totalDataCw) {
		dataCw.push(padBytes[padIdx % 2]!);
		padIdx++;
	}

	const blocks: number[][] = [];
	const ecBlocks: number[][] = [];
	const div = rsDivisor(ecCwPerBlock);
	let offset = 0;
	for (let i = 0; i < b1 + b2; i++) {
		const blkLen = i < b1 ? d1 : d2;
		const blk = dataCw.slice(offset, offset + blkLen);
		offset += blkLen;
		blocks.push(blk);
		ecBlocks.push(rsRemainder(blk, div));
	}

	const finalCw: number[] = [];
	const maxD = Math.max(d1, d2);
	for (let i = 0; i < maxD; i++) {
		for (const blk of blocks) {
			if (i < blk.length) finalCw.push(blk[i]!);
		}
	}
	for (let i = 0; i < ecCwPerBlock; i++) {
		for (const eblk of ecBlocks) finalCw.push(eblk[i]!);
	}

	const size = version * 4 + 17;
	const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const isFunc = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

	const setFunc = (r: number, c: number, dark: boolean) => {
		if (r >= 0 && r < size && c >= 0 && c < size) {
			modules[r]![c] = dark;
			isFunc[r]![c] = true;
		}
	};

	const drawFinder = (row: number, col: number) => {
		for (let dr = -1; dr <= 7; dr++) {
			for (let dc = -1; dc <= 7; dc++) {
				const r = row + dr;
				const c = col + dc;
				if (r >= 0 && r < size && c >= 0 && c < size) {
					const dark =
						dr >= 0 &&
						dr <= 6 &&
						dc >= 0 &&
						dc <= 6 &&
						(dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
					setFunc(r, c, dark);
				}
			}
		}
	};

	drawFinder(0, 0);
	drawFinder(0, size - 7);
	drawFinder(size - 7, 0);

	const align = QR_ALIGNMENT[version]!;
	for (const r of align) {
		for (const c of align) {
			if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
			for (let dr = -2; dr <= 2; dr++) {
				for (let dc = -2; dc <= 2; dc++) {
					setFunc(r + dr, c + dc, Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0));
				}
			}
		}
	}

	for (let i = 8; i < size - 8; i++) {
		setFunc(6, i, i % 2 === 0);
		setFunc(i, 6, i % 2 === 0);
	}

	setFunc(size - 8, 8, true);
	for (let i = 0; i < 9; i++) {
		if (i !== 6) {
			setFunc(8, i, false);
			setFunc(i, 8, false);
		}
	}
	for (let i = 0; i < 8; i++) {
		setFunc(8, size - 1 - i, false);
		if (i < 7) setFunc(size - 1 - i, 8, false);
	}

	if (version >= 7) {
		for (let i = 0; i < 6; i++) {
			for (let j = 0; j < 3; j++) {
				setFunc(size - 11 + j, i, false);
				setFunc(i, size - 11 + j, false);
			}
		}
	}

	const allBits: number[] = [];
	for (const cw of finalCw) {
		for (let i = 7; i >= 0; i--) allBits.push((cw >> i) & 1);
	}

	let bitIdx = 0;
	let upward = true;
	let col = size - 1;
	while (col > 0) {
		if (col === 6) col--;
		for (let i = 0; i < size; i++) {
			const row = upward ? size - 1 - i : i;
			for (const dc of [0, -1]) {
				const c = col + dc;
				if (!isFunc[row]![c]) {
					modules[row]![c] = bitIdx < allBits.length ? Boolean(allBits[bitIdx++]) : false;
				}
			}
		}
		upward = !upward;
		col -= 2;
	}

	for (let r = 0; r < size; r++) {
		for (let c = 0; c < size; c++) {
			if (!isFunc[r]![c] && (r + c) % 2 === 0) {
				modules[r]![c] = !modules[r]![c];
			}
		}
	}

	// Format bits for EC Level L (01) and Mask 0 (000) -> 0x77c4
	const fmt = 0x77c4;
	for (let i = 0; i < 6; i++) setFunc(8, i, Boolean((fmt >> (14 - i)) & 1));
	setFunc(8, 7, Boolean((fmt >> 8) & 1));
	setFunc(8, 8, Boolean((fmt >> 7) & 1));
	setFunc(7, 8, Boolean((fmt >> 6) & 1));
	for (let i = 9; i < 15; i++) setFunc(14 - i, 8, Boolean((fmt >> (14 - i)) & 1));

	for (let i = 0; i < 7; i++) setFunc(size - 1 - i, 8, Boolean((fmt >> (14 - i)) & 1));
	for (let i = 0; i < 8; i++) setFunc(8, size - 8 + i, Boolean((fmt >> (7 - i)) & 1));

	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1f25);
		const vbits = (version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = Boolean((vbits >> i) & 1);
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFunc(a, b, bit);
			setFunc(b, a, bit);
		}
	}

	return modules;
}

export class QrCodeExportModal extends Modal {
	private payload: string;

	constructor(app: App, payload: string) {
		super(app);
		this.payload = payload;
		this.setTitle('Scan qr code to transfer setup');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: 'Scan this qr code with your iOS or Android camera and tap "open in Obsidian" to copy and load your setup safely without opening a browser.',
			cls: 'cds-backup-meta',
		});

		const container = contentEl.createDiv({ cls: 'cds-qr-container' });
		const transferUri = `obsidian://crypt-drive-sync-import?payload=${encodePayloadBase64Url(this.payload)}`;

		try {
			const matrix = buildQrMatrix(transferUri);
			const scale = 4;
			const quietZone = 4;
			const canvasSize = (matrix.length + quietZone * 2) * scale;

			const canvas = container.createEl('canvas', { cls: 'cds-qr-image' });
			canvas.width = canvasSize;
			canvas.height = canvasSize;

			const ctx = canvas.getContext('2d');
			if (ctx) {
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, canvasSize, canvasSize);
				ctx.fillStyle = '#000000';
				for (let r = 0; r < matrix.length; r++) {
					const row = matrix[r]!;
					for (let c = 0; c < row.length; c++) {
						if (row[c]) {
							ctx.fillRect((c + quietZone) * scale, (r + quietZone) * scale, scale, scale);
						}
					}
				}
			}
		} catch (e) {
			container.createEl('p', {
				text: `Could not render QR code (${String(e)}). Use "Copy raw payload string" below instead.`,
				cls: 'mod-warning',
			});
		}

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Copy raw payload string')
					.onClick(async () => {
						await navigator.clipboard.writeText(this.payload);
						new Notice('Qr payload string copied to clipboard!');
					}),
			)
			.addButton((btn) => btn.setButtonText('Close').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

export default class CryptDriveSync extends Plugin {
	settings: Settings = { ...DEFAULTS };
	lastResult = '';
	private base = new Map<string, BaseEntry>();
	private baseDirs = new Set<string>();
	private pageToken?: string;
	private remoteFilesCache = new Map<string, CachedRemoteFile>();
	private running = false;
	private lastSyncAt = 0;
	private lastTrashPruneAt = 0;
	private logLines: string[] = [];
	private status?: { el: HTMLElement; icon: HTMLElement; text: HTMLElement };
	private crypt?: { key: string; crypt: Crypt };
	private editTimer = 0;
	private editedDuringSync = false;
	private createRoot = false;

	backupManager!: BackupManager;
	onConfigImported?: () => void;

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async promptImportConfig(onDone?: () => void): Promise<void> {
		new ImportConfigModal(this.app, async (rawJson) => {
			await this.importCompactConfig(rawJson);
			onDone?.();
		}).open();
	}

	/** Permanently deletes both vault files and backups for this vault from remote _deleted across all date folders. */
	async emptyTrash(): Promise<void> {
		const notice = new Notice('Emptying remote trash folder...', 0);
		try {
			const remote = await this.remote(true, '_deleted');
			if (!remote) {
				notice.hide();
				return;
			}

			const vaultName = PathSanitizer.sanitizeVaultName(this.settings.folder, this.app.vault.getName());
			const vaultNotesSubpath = `vaults/${vaultName}/`;
			const vaultBackupsSubpath = `_backups/${vaultName}/`;

			const { files } = await remote.list();
			let count = 0;

			for (const [path] of files.entries()) {
				// Match items in either vaults/[vault_name]/ or _backups/[vault_name]/
				const isVaultItem = path.includes(vaultNotesSubpath) || path.includes(vaultBackupsSubpath);
				if (!isVaultItem) continue;

				try {
					await remote.trash(path);
					count++;
				} catch (err) {
					this.log(`\u26a0 Failed to remove ${path} from trash: ${String(err)}`);
				}
			}

			await remote.cleanEmptyRemoteFolders();
			const removedFolders = await remote.purgeEmptySubfoldersForSubpaths([
				`vaults/${vaultName}`,
				`_backups/${vaultName}`,
			]);
			const totalRemoved = count + removedFolders;

			if (totalRemoved === 0) {
				notice.hide();
				new Notice(`Remote trash for vault "${vaultName}" is already empty.`);
				return;
			}

			notice.hide();
			new Notice(`Remote trash emptied (${totalRemoved} item(s) removed for vault "${vaultName}").`);
			this.log(`Emptied remote trash for vault "${vaultName}" (${totalRemoved} item(s) deleted).`);
		} catch (e) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Failed to empty trash: ${msg}`);
			this.log(`\u26a0 Empty trash error: ${msg}`);
		}
	}

	/** Automatically prunes expired vault files and backups in _deleted older than trashRetentionDays. */
	async pruneTrash(): Promise<void> {
		const retentionDays = Number(this.settings.trashRetentionDays || 0);
		if (retentionDays <= 0) return;

		const remote = await this.remote(false, '_deleted');
		if (!remote) return;

		const vaultName = PathSanitizer.sanitizeVaultName(this.settings.folder, this.app.vault.getName());
		const vaultNotesSubpath = `vaults/${vaultName}/`;
		const vaultBackupsSubpath = `_backups/${vaultName}/`;
		const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

		try {
			const { files } = await remote.list();
			let prunedCount = 0;

			for (const [path, entry] of files.entries()) {
				// Skip items belonging to other vaults
				const isVaultItem = path.includes(vaultNotesSubpath) || path.includes(vaultBackupsSubpath);
				if (!isVaultItem) continue;

				// Extract date from YYYY-MM-DD prefix in path
				const dateMatch = path.match(/^(\d{4}-\d{2}-\d{2})/);
				let fileTimestamp = entry.mtime;

				if (dateMatch && dateMatch[1]) {
					const parsedDate = Date.parse(dateMatch[1]);
					if (!isNaN(parsedDate)) {
						fileTimestamp = parsedDate;
					}
				}

				if (fileTimestamp && fileTimestamp < cutoffTime) {
					try {
						await remote.trash(path);
						prunedCount++;
						this.log(`Pruned expired trashed item for "${vaultName}" (${retentionDays}+ days old): ${path}`);
					} catch (err) {
						this.log(`\u26a0 Failed to prune trashed item ${path}: ${String(err)}`);
					}
				}
			}

			if (prunedCount > 0) {
				await remote.cleanEmptyRemoteFolders();
			}
		} catch (e) {
			this.log(`\u26a0 Trash prune check failed: ${String(e)}`);
		}
	}

	exportConfigPayload(): string {
		const payload = {
			version: 1,
			settings: {
				clientId: this.settings.clientId,
				rootPath: this.settings.rootPath,
				folder: this.settings.folder,
				dirNameEncrypt: this.settings.dirNameEncrypt,
				trashDir: this.settings.trashDir,
				syncOnStart: this.settings.syncOnStart,
				intervalMin: this.settings.intervalMin,
				afterEditSec: this.settings.afterEditSec,
				exclude: this.settings.exclude,
				maxFileMb: this.settings.maxFileMb,
				maxDeletePct: this.settings.maxDeletePct,
				backupEnabled: this.settings.backupEnabled,
				maxBackups: this.settings.maxBackups,
				localBackupFolder: this.settings.localBackupFolder,
				syncDotFolders: this.settings.syncDotFolders,
				useRawRegex: this.settings.useRawRegex,
				createPreRestoreSnapshot: this.settings.createPreRestoreSnapshot,
				wizardDone: true,
			},
			secrets: {
				password: this.secret(PASSWORD_ID) || '',
				salt: this.secret(SALT_ID) || '',
				clientSecret: this.secret(CLIENT_SECRET_ID) || '',
				token: this.secret(TOKEN_ID) || '',
			},
		};
		return JSON.stringify(payload);
	}

	exportConfigPayloadCompact(): string {
		const payload = {
			v: 1,
			s: {
				ci: this.settings.clientId,
				r: this.settings.rootPath,
				f: this.settings.folder,
				e: this.settings.dirNameEncrypt,
				t: this.settings.trashDir,
			},
			sec: {
				p: this.secret(PASSWORD_ID) || '',
				s: this.secret(SALT_ID) || '',
				cs: this.secret(CLIENT_SECRET_ID) || '',
				tk: this.secret(TOKEN_ID) || '',
			},
		};
		return JSON.stringify(payload);
	}

    async exportConfigToClipboard(): Promise<void> {
		try {
			const jsonString = this.exportConfigPayloadCompact();
			await navigator.clipboard.writeText(jsonString);
			new Notice('Configuration payload copied to clipboard!');
		} catch (e) {
			new Notice(`Failed to copy to clipboard: ${String(e)}`);
		}
	}

	async importConfig(rawJson: string): Promise<void> {
		await this.importCompactConfig(rawJson);
	}

	async importCompactConfig(rawJson: string): Promise<void> {
		try {
			const data = JSON.parse(rawJson) as PayloadData | null;
			if (!data || typeof data !== 'object') throw new Error('Invalid JSON format');

			if (data.v === 1 && data.s) {
				if (typeof data.s.ci === 'string' && data.s.ci !== this.settings.clientId) {
					this.settings.clientId = data.s.ci;
					this.logout();
				}
				if (data.s.r) this.settings.rootPath = data.s.r;
				if (data.s.f) this.settings.folder = data.s.f;
				if (typeof data.s.e === 'boolean') this.settings.dirNameEncrypt = data.s.e;
				if (data.s.t) this.settings.trashDir = data.s.t;
				this.settings.wizardDone = true;
				await this.saveSettings();

				if (data.sec) {
					if (data.sec.p) await this.setSecret(PASSWORD_ID, data.sec.p);
					if (data.sec.s) await this.setSecret(SALT_ID, data.sec.s);
					if (data.sec.cs) await this.setSecret(CLIENT_SECRET_ID, data.sec.cs);
					if (data.sec.tk) {
						const parsedToken = parseRefreshToken(data.sec.tk) || data.sec.tk.trim();
						if (parsedToken) await this.setSecret(TOKEN_ID, parsedToken);
					}
				}
			} else if (data.settings) {
				const prevClientId = this.settings.clientId;
				this.settings = { ...this.settings, ...data.settings, wizardDone: true };
				if (this.settings.clientId !== prevClientId) this.logout();
				await this.saveSettings();
				if (data.secrets) {
					if (data.secrets.password) await this.setSecret(PASSWORD_ID, data.secrets.password);
					if (data.secrets.salt) await this.setSecret(SALT_ID, data.secrets.salt);
					if (data.secrets.clientSecret) await this.setSecret(CLIENT_SECRET_ID, data.secrets.clientSecret);
					if (data.secrets.token) {
						const parsedToken = parseRefreshToken(data.secrets.token) || data.secrets.token.trim();
						if (parsedToken) await this.setSecret(TOKEN_ID, parsedToken);
					}
				}
			}

			this.onConfigImported?.();
			new Notice(
				this.ready()
					? 'Configuration imported successfully! Ready to sync.'
					: 'Configuration imported! Sign in to Google to start syncing.',
			);
		} catch (e) {
			new Notice(`Import failed: ${String(e)}`);
		}
	}

	showQrExportModal(): void {
		new QrCodeExportModal(this.app, this.exportConfigPayloadCompact()).open();
	}

	getRemoteSubsystemPath(subsystem: 'vaults' | '_backups' | '_deleted'): string {
		const root = PathSanitizer.sanitizeRootPath(this.settings.rootPath);
		const vaultName = PathSanitizer.sanitizeVaultName(this.settings.folder, this.app.vault.getName());
		return subsystem === '_deleted' ? `${root}/_deleted` : `${root}/${subsystem}/${vaultName}`;
	}

	getRemoteVaultPath(): string {
		return this.getRemoteSubsystemPath('vaults');
	}

	async onload() {
		setLanguage(getLanguage());
		this.lastResult = T.never;
		const rawData: unknown = await this.loadData();
		const isFreshInstall = rawData === null || rawData === undefined;
		this.settings = { ...DEFAULTS, ...(rawData as Partial<Settings> | null) };
		if (!this.settings.folder) this.settings.folder = this.app.vault.getName();

		// If plugin folder was manually wiped on disk, clear orphaned keychain secrets
		if (isFreshInstall) {
			const deviceId = this.deviceId();
			for (const key of [TOKEN_ID, PASSWORD_ID, SALT_ID, CLIENT_SECRET_ID]) {
				this.app.secretStorage.setSecret(`crypt-drive-sync-${deviceId}-${key}`, '');
				this.app.secretStorage.setSecret(`crypt-drive-sync-${key}`, '');
			}
		}

		this.base = await this.loadBase();

		this.backupManager = new BackupManager(this);

		this.addSettingTab(new CryptDriveSyncSettingTab(this));
		this.addRibbonIcon('refresh-cw', T.ribbon, () => void this.sync());

		if (!Platform.isMobile) {
			const el = this.addStatusBarItem();
			el.addClass('mod-clickable', 'cds-status');
			const icon = el.createSpan({ cls: 'cds-status-icon' });
			setIcon(icon, 'lock');
			this.status = { el, icon, text: el.createSpan() };
			this.setStatus(T.statusIdle, T.statusTip(this.lastResult));
			this.registerDomEvent(el, 'click', () => void this.sync());
		}

		this.addCommand({ id: 'sync-now', name: T.cmdSync, callback: () => void this.sync() });
		this.addCommand({ id: 'show-plan', name: T.cmdPlan, callback: () => void this.sync({ dryRun: true }) });
		this.addCommand({ id: 'reconcile-from-cloud', name: T.cmdReconcile, callback: () => void this.sync({ reconcile: true }) });
		this.addCommand({ id: 'show-log', name: T.cmdLog, callback: () => this.openLog() });
		this.addCommand({ id: 'reset-state', name: T.cmdReset, callback: () => void this.resetState(true) });
		this.addCommand({ id: 'setup', name: T.cmdWizard, callback: () => this.openWizard() });
		this.addCommand({ id: 'forget-device', name: T.forgetName, callback: () => void this.forgetDevice() });
		this.addCommand({ id: 'explore-remote-backups', name: 'Remote backup explorer', callback: () => new RemoteBackupsModal(this, this.backupManager).open() });

		this.registerObsidianProtocolHandler('crypt-drive-sync-import', async (params) => {
			const encoded = params.payload?.trim();
			if (!encoded) {
				new Notice('Qr link is missing configuration data.');
				return;
			}
			try {
				const rawJson = decodePayloadBase64Url(encoded);
				JSON.parse(rawJson);
				try {
					await navigator.clipboard.writeText(rawJson);
					new Notice('Configuration copied to clipboard and loaded — tap "import & apply" to confirm.');
				} catch {
					new Notice('Configuration loaded from qr link — tap "import & apply" to confirm.');
				}
				new ImportConfigModal(
					this.app,
					async (confirmedJson) => {
						await this.importCompactConfig(confirmedJson);
					},
					rawJson,
				).open();
			} catch (e) {
				new Notice(`Invalid QR setup link: ${String(e)}`);
			}
		});

		this.app.workspace.onLayoutReady(() => {
			if (!this.ready()) {
				if (!this.settings.wizardDone) this.openWizard();
			} else if (this.settings.syncOnStart) {
				void this.sync({ quiet: true });
			}
		});

		const onEdit = () => {
			const sec = Number(this.settings.afterEditSec);
			if (!sec || sec <= 0) return;
			if (this.running) {
				this.editedDuringSync = true;
				return;
			}
			window.clearTimeout(this.editTimer);
			this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), sec * 1000);
		};

		for (const ev of ['create', 'modify', 'delete', 'rename'] as const) {
			this.registerEvent(this.app.vault.on(ev as 'create', onEdit));
		}

		this.registerInterval(
			window.setInterval(() => {
				const min = Number(this.settings.intervalMin);
				if (min > 0 && Date.now() - this.lastSyncAt >= min * 60_000) void this.sync({ quiet: true });
			}, 60_000),
		);

		this.registerDomEvent(document, 'visibilitychange', () => {
			const min = Number(this.settings.intervalMin);
			if (min > 0 && document.visibilityState === 'visible' && Date.now() - this.lastSyncAt >= min * 60_000) {
				void this.sync({ quiet: true });
			}
		});

		this.addCommand({ id: 'create-backup', name: T.cmdBackup, callback: () => void this.backupManager.createBackup() });
	}

	refreshTimers(): void {
		window.clearTimeout(this.editTimer);
		this.editTimer = 0;
	}

	onunload() {
		window.clearTimeout(this.editTimer);
	}

	async sync(opts: { quiet?: boolean; dryRun?: boolean; reconcile?: boolean } = {}): Promise<void> {
		if (this.running) {
			if (!opts.quiet) new Notice(`${T.noticePrefix}: Sync is already in progress...`);
			return;
		}
		this.running = true;
		this.editedDuringSync = false;
		this.setStatus(T.statusRunning, T.statusTip(this.lastResult), true);
		const base = this.base;
		let again = false;
		try {
			if (opts.reconcile) {
				this.pageToken = undefined;
				this.remoteFilesCache = new Map();
			}
			const remote = await this.remote(!opts.quiet);
			if (!remote) return;
			const local = new VaultFs(this);
			const prevPageToken = this.pageToken;
			const [l, r] = await Promise.all([local.list(), remote.list()]);

			this.pageToken = remote.getPageToken();
			this.remoteFilesCache = remote.getFilesCache();

			const warnings = [...r.warnings, ...this.filter(l, r.files)];
			const opts1 = { minDeleteCount: MIN_DELETE_COUNT, maxDeletePct: Number(this.settings.maxDeletePct), reconcile: opts.reconcile };
			let p = plan(l, r.files, base, opts1);
			p.warnings.unshift(...warnings);
			p.warnings.forEach((w) => this.log(`\u26a0 ${w}`));

			const hasSyncActions = p.actions.some((a) => a.type !== 'adopt');

			if (opts.dryRun) {
				this.finish(T.planTitle, false);
				await new PlanModal(this.app, p, false).ask();
				return;
			}
			if (p.blocked || ((this.settings.confirmPlan || opts.reconcile) && hasSyncActions)) {
				const remoteGone = r.files.size === 0 && (base.size > 0 || (Boolean(opts.reconcile) && l.size > 0));
				if (!(await new PlanModal(this.app, p, !remoteGone).ask())) {
					this.finish(p.blocked ? T.stopped(p.blocked) : T.cancelled, true);
					return;
				}
				p = {
					...plan(l, r.files, base, { minDeleteCount: Infinity, maxDeletePct: 100, reconcile: opts.reconcile }),
					warnings: p.warnings,
				};
			}
			if (!hasSyncActions) {
				let adopted = false;
				for (const a of p.actions) {
					if (a.type === 'adopt') {
						base.set(a.path, a.entry);
						adopted = true;
					}
				}
				if (adopted || this.pageToken !== prevPageToken) {
					await this.saveBase();
				}
				const hasWarn = p.warnings.length > 0;
				const msg = hasWarn ? `${T.noChanges} (${p.warnings.length} warning(s) — see log)` : T.noChanges;
				this.finish(msg, !opts.quiet || hasWarn, false, hasWarn);
				return;
			}

			const currentLocalDirs = await local.listDirs();

			const res = await apply(p, local, remote, base, {
				deviceName: this.settings.deviceName || this.defaultDeviceName(),
				now: () => new Date(),
				saveBase: async () => {
					if (base !== this.base) throw new Error(T.staleSettings);
					this.remoteFilesCache = remote.getFilesCache();
					await this.saveBase(currentLocalDirs);
				},
				onProgress: (done, total) => this.setStatus(`${T.statusRunning} ${done}/${total}`, T.statusTip(this.lastResult), true),
				log: (m) => this.log(m),
			});

			await remote.cleanEmptyRemoteFolders();
			this.remoteFilesCache = remote.getFilesCache();
			await this.saveBase(currentLocalDirs);

			if (Date.now() - this.lastTrashPruneAt >= 6 * 60 * 60_000) {
				this.lastTrashPruneAt = Date.now();
				void this.pruneTrash();
			}

			const n = (t: Action['type']) => p.actions.filter((a) => a.type === t).length;
			const parts = T.summary(n('upload'), n('download'));
			if (n('trashRemote') + n('trashLocal')) parts.push(T.sumTrashed(n('trashRemote') + n('trashLocal')));
			if (res.conflicts.length) parts.push(T.sumConflicts(res.conflicts.length));
			if (res.errors.length) parts.push(T.sumErrors(res.errors.length));
			if (p.warnings.length) parts.push(`${p.warnings.length} warning(s) (see log)`);
			const hasWarn = p.warnings.length > 0 || res.errors.length > 0;
			this.finish(parts.join(', '), true, res.errors.length > 0, hasWarn);
		} catch (e) {
			if (e instanceof RootMissingError && !opts.dryRun && (await this.askCreateRoot())) again = true;
			else this.finish(T.error(humanError(e)), true, true);
		} finally {
			this.running = false;
			if (again) void this.sync(opts);
			const editSec = Number(this.settings.afterEditSec);
			if (this.editedDuringSync && editSec > 0) {
				window.clearTimeout(this.editTimer);
				this.editTimer = window.setTimeout(() => void this.sync({ quiet: true }), editSec * 1000);
			}
		}
	}

	private filter(l: Map<string, LocalEntry>, r: Map<string, RemoteEntry>): string[] {
		const ex = this.settings.useRawRegex ? parseRawRegex(this.settings.exclude) : globs(this.settings.exclude);
		const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.settings.localBackupFolder);
		const max = Number(this.settings.maxFileMb) * 1024 * 1024;
		const warnings: string[] = [];

		for (const path of new Set([...l.keys(), ...r.keys()])) {
			const isLocalBackup = path === localBackupFolder || path.startsWith(`${localBackupFolder}/`);
			const isDotFolder = !this.settings.syncDotFolders && path.split('/').some((seg) => seg.startsWith('.'));
			const big = (l.get(path)?.size ?? 0) > max || (r.get(path)?.size ?? 0) > max;

			if (isLocalBackup || isDotFolder || ex.some((g: RegExp) => g.test(path)) || big) {
				l.delete(path);
				r.delete(path);
				if (big) warnings.push(T.tooBig(Number(this.settings.maxFileMb), path));
			}
		}
		return warnings;
	}

	private finish(msg: string, notify: boolean, failed = false, hasWarnings = false) {
		this.lastSyncAt = Date.now();
		this.lastResult = `${new Date().toLocaleString()}: ${msg}`;
		this.log(msg);

		this.setStatus(
			failed || hasWarnings ? T.statusError : T.statusOk(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
			T.statusTip(this.lastResult),
		);

		if (failed || hasWarnings) {
			new AlertModal(this.app, T.noticePrefix, msg).open();
		} else if (notify) {
			new Notice(`${T.noticePrefix}: ${msg}`);
		}
	}

	private setStatus(text: string, tip: string, running = false) {
		if (!this.status) return;
		this.status.text.setText(text);
		this.status.el.toggleClass('is-running', running);
		setTooltip(this.status.el, tip, { placement: 'top' });
	}

	log(msg: string) {
		this.logLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
		if (this.logLines.length > 500) this.logLines.shift();
	}

	private sid(key: string): string {
		return `crypt-drive-sync-${this.deviceId()}-${key}`;
	}

	secret(key: string): string {
		const v = this.app.secretStorage.getSecret(this.sid(key));
		if (v !== null) return v;
		const old = this.app.secretStorage.getSecret(`crypt-drive-sync-${key}`) ?? '';
		if (old) this.storeSecret(key, old);
		return old;
	}

	private storeSecret(key: string, value: string) {
		this.app.secretStorage.setSecret(this.sid(key), value);
	}

	async setSecret(key: string, value: string): Promise<void> {
		this.storeSecret(key, value);
		if (key === PASSWORD_ID || key === SALT_ID) await this.resetState();
	}

	async getCrypt(): Promise<Crypt | undefined> {
		const password = this.secret(PASSWORD_ID);
		if (!password) return undefined;
		const salt = this.secret(SALT_ID);
		const key = JSON.stringify([password, salt, this.settings.dirNameEncrypt]);
		if (this.crypt?.key !== key) {
			this.crypt = { key, crypt: await Crypt.create({ password, salt, dirNameEncrypt: this.settings.dirNameEncrypt }) };
		}
		return this.crypt.crypt;
	}

	ready(): boolean {
		return this.hasClient() && this.isLoggedIn() && !!this.secret(PASSWORD_ID);
	}

	hasBuiltinClient(): boolean {
		return !!GOOGLE_CLIENT.id;
	}

	hasClient(): boolean {
		const c = this.client();
		return !!c.id && !!c.secret;
	}

	async setClient(id: string, secret: string): Promise<void> {
		if (id !== this.settings.clientId) {
			this.settings.clientId = id;
			await this.saveData(this.settings);
			this.logout();
		}
		if (secret) this.storeSecret(CLIENT_SECRET_ID, secret);
	}

	async remote(report = true, subsystem: 'vaults' | '_backups' | '_deleted' = 'vaults'): Promise<CryptDriveFs | undefined> {
		const s = this.settings;
		const missing = !this.hasClient()
			? T.needClient
			: !this.isLoggedIn()
				? T.needLogin
				: !this.secret(PASSWORD_ID)
					? T.needPassword
					: '';
		if (missing) {
			if (report) this.finish(T.notConfigured(missing), true);
			return undefined;
		}
		const c = this.client();
		const auth = new GoogleAuth(req, c.id, c.secret, this.secret(TOKEN_ID));
		const crypt = (await this.getCrypt())!;
		const vaultName = PathSanitizer.sanitizeVaultName(s.folder, this.app.vault.getName());
		const remoteSubFolder = subsystem === '_deleted' ? '_deleted' : `${subsystem}/${vaultName}`;
		const isVault = subsystem === 'vaults';

		return new CryptDriveFs(
			new DriveClient(req, auth),
			crypt,
			{
				rootPath: s.rootPath,
				folder: remoteSubFolder,
				trashDir: subsystem === '_deleted' ? '' : s.trashDir,
				createRoot: this.createRoot,
				dirNameEncrypt: s.dirNameEncrypt,
			},
			(encSize: number) => Crypt.decryptedSize(encSize),
			isVault ? this.pageToken : undefined,
			isVault ? this.remoteFilesCache : undefined,
		);
	}

	private client(): { id: string; secret: string } {
		const id = this.settings.clientId.trim();
		return id ? { id, secret: this.secret(CLIENT_SECRET_ID) } : GOOGLE_CLIENT;
	}

	isLoggedIn(): boolean {
		return !!this.secret(TOKEN_ID);
	}

	logout() {
		this.storeSecret(TOKEN_ID, '');
	}

	async login(): Promise<void> {
		const c = this.client();
		if (!this.hasClient()) {
			new Notice(T.noBuiltinClient);
			return;
		}
		const token = await new LoginModal(this.app, c.id, c.secret).ask();
		if (token) {
			this.storeSecret(TOKEN_ID, token);
			new Notice(T.googleConnected);
		}
	}

	private async askCreateRoot(): Promise<boolean> {
		const ok = await new ConfirmModal(this.app, T.rootTitle, T.rootText(this.settings.rootPath), T.create).ask();
		if (ok) this.createRoot = true;
		return ok;
	}

	async probe(): Promise<{ ok: boolean; text: string }> {
		try {
			const remote = await this.remote(false);
			if (!remote) return { ok: false, text: T.probeNeedSetup };
			const { files, warnings } = await remote.list();
			warnings.forEach((w) => this.log(`\u26a0 ${w}`));
			return { ok: true, text: files.size ? T.probeOkFiles(files.size) : T.probeOkEmpty };
		} catch (e) {
			if (e instanceof RootMissingError) return { ok: true, text: T.probeNoRoot(this.settings.rootPath) };
			return { ok: false, text: `\u2717 ${humanError(e)}` };
		}
	}

	async check(): Promise<void> {
		new Notice((await this.probe()).text);
	}

	openWizard(onDone: () => void = () => {}) {
		new SetupWizard(this, onDone).open();
	}

	async forgetDevice(onDone: () => void = () => {}): Promise<void> {
		if (!(await new ConfirmModal(this.app, T.forgetName, T.forgetConfirm, T.forgetButton).ask())) return;
		
		const deviceId = this.deviceId();
		const keys = [TOKEN_ID, PASSWORD_ID, SALT_ID, CLIENT_SECRET_ID];
		
		for (const key of keys) {
			// Clear scoped secret storage
			this.app.secretStorage.setSecret(`crypt-drive-sync-${deviceId}-${key}`, '');
			// Clear legacy un-scoped secret storage
			this.app.secretStorage.setSecret(`crypt-drive-sync-${key}`, '');
		}
		
		this.settings = { ...DEFAULTS, folder: this.app.vault.getName() };
		await this.saveData(this.settings);
		await this.resetState();
		this.crypt = undefined;
		this.createRoot = false;
		this.lastResult = T.never;
		onDone();
		this.openWizard(onDone);
	}

	async markWizardDone(): Promise<void> {
		if (this.settings.wizardDone) return;
		this.settings.wizardDone = true;
		await this.saveData(this.settings);
	}

	async setLocation(rootPath: string, folder: string): Promise<void> {
		if (rootPath === this.settings.rootPath && folder === this.settings.folder) return;
		Object.assign(this.settings, { rootPath, folder });
		await this.saveData(this.settings);
		await this.resetState();
	}

	openLog() {
		new TextModal(this.app, T.logTitle, this.logLines.join('\n') || T.logEmpty).open();
	}

	async setBase(newBase: Map<string, BaseEntry>): Promise<void> {
		this.base = newBase;
		await this.saveBase();
	}

	async resetState(notify = false): Promise<void> {
		this.base = new Map();
		this.pageToken = undefined;
		this.remoteFilesCache = new Map();
		await this.saveBase();
		if (notify) new Notice(T.stateReset);
	}

	defaultDeviceName(): string {
		if (Platform.isIosApp) return Platform.isTablet ? 'iPad' : 'iPhone';
		if (Platform.isAndroidApp) return 'Android';
		return Platform.isMacOS ? 'Mac' : Platform.isWin ? 'Windows' : 'Linux';
	}

	private get statePath() {
		return normalizePath(`${this.manifest.dir}/state.json`);
	}

	private deviceId(): string {
		let id = this.app.loadLocalStorage('crypt-drive-sync-device') as string | null;
		if (!id) {
			id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
			this.app.saveLocalStorage('crypt-drive-sync-device', id);
		}
		return id;
	}

	private async loadBase(): Promise<Map<string, BaseEntry>> {
		try {
			const raw = await this.app.vault.adapter.read(this.statePath);
			const st = JSON.parse(raw) as {
				device?: string;
				base?: Record<string, BaseEntry>;
				dirs?: string[];
				pageToken?: string;
				remoteFiles?: Record<string, CachedRemoteFile>;
			};
			if (st.device === this.deviceId()) {
				if (st.dirs) this.baseDirs = new Set(st.dirs);
				if (st.pageToken) this.pageToken = st.pageToken;
				if (st.remoteFiles) this.remoteFilesCache = new Map(Object.entries(st.remoteFiles));
				if (st.base) return new Map(Object.entries(st.base));
			}
		} catch {
			// state file missing or unreadable
		}
		this.baseDirs = new Set();
		this.pageToken = undefined;
		this.remoteFilesCache = new Map();
		return new Map();
	}

	async saveBase(currentDirs?: Set<string>): Promise<void> {
		if (currentDirs) this.baseDirs = currentDirs;
		await this.app.vault.adapter.write(
			this.statePath,
			JSON.stringify({
				device: this.deviceId(),
				base: Object.fromEntries(this.base),
				dirs: Array.from(this.baseDirs),
				pageToken: this.pageToken ?? null,
				remoteFiles: Object.fromEntries(this.remoteFilesCache),
			}),
		);
	}
}

class VaultFs implements LocalFs {
	private plugin: CryptDriveSync;
	private app: App;
	private real = new Map<string, string>();

	constructor(plugin: CryptDriveSync) {
		this.plugin = plugin;
		this.app = plugin.app;
	}

	private path(p: string): string {
		return this.real.get(p) ?? p;
	}

	async listDirs(): Promise<Set<string>> {
		const dirs = new Set<string>();
		const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
		const scan = async (dir: string) => {
			const list = await this.app.vault.adapter.list(dir);
			for (const folder of list.folders) {
				const nfc = folder.normalize('NFC');
				const isLocalBackup = nfc === localBackupFolder || nfc.startsWith(`${localBackupFolder}/`);
				const isDotFolder = !this.plugin.settings.syncDotFolders && nfc.split('/').some((seg) => seg.startsWith('.'));
				if (!isLocalBackup && !isDotFolder) {
					dirs.add(nfc);
					await scan(folder);
				}
			}
		};
		await scan('');
		return dirs;
	}

	async list(): Promise<Map<string, LocalEntry>> {
		const out = new Map<string, LocalEntry>();
		this.real.clear();
		if (this.plugin.settings.syncDotFolders) {
			await this.scanAdapter('', out);
		} else {
			for (const f of this.app.vault.getAllLoadedFiles()) if (f.path !== '/') this.real.set(f.path.normalize('NFC'), f.path);
			for (const f of this.app.vault.getFiles()) {
				const e = await this.stat(f.path.normalize('NFC'));
				if (e) out.set(f.path.normalize('NFC'), e);
			}
		}
		return out;
	}

	private async scanAdapter(dir: string, out: Map<string, LocalEntry>): Promise<void> {
		const list = await this.app.vault.adapter.list(dir);
		for (const file of list.files) {
			const nfc = file.normalize('NFC');
			this.real.set(nfc, file);
			const st = await this.stat(nfc);
			if (st) out.set(nfc, st);
		}
		for (const folder of list.folders) {
			await this.scanAdapter(folder, out);
		}
	}

	async stat(path: string): Promise<LocalEntry | undefined> {
		const st = await this.app.vault.adapter.stat(this.path(path));
		return st?.type === 'file' ? { mtime: st.mtime, size: st.size } : undefined;
	}

	private file(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(this.path(path));
		return f instanceof TFile ? f : null;
	}

	async read(path: string): Promise<Uint8Array> {
		const realPath = this.path(path);
		const f = this.file(path);
		if (f) {
			return new Uint8Array(await this.app.vault.readBinary(f));
		}
		if (await this.app.vault.adapter.exists(realPath)) {
			return new Uint8Array(await this.app.vault.adapter.readBinary(realPath));
		}
		throw new Error(`not on this device: ${path}`);
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<LocalEntry> {
		const buf = data.slice().buffer;
		const f = this.file(path);
		if (f) {
			await this.app.vault.modifyBinary(f, buf, { mtime });
		} else {
			const realPath = this.path(path);
			const segs = realPath.split('/');
			let dir = '';
			for (let i = 1; i < segs.length; i++) {
				const key = segs.slice(0, i).join('/');
				const real = this.real.get(key) ?? (dir ? `${dir}/${segs[i - 1]!}` : segs[i - 1]!);
				if (!(await this.app.vault.adapter.exists(real))) {
					await this.app.vault.adapter.mkdir(real);
				}
				this.real.set(key, real);
				dir = real;
			}
			await this.app.vault.adapter.writeBinary(realPath, buf, { mtime });
			this.real.set(path, realPath);
		}
		const st = await this.stat(path);
		if (!st) throw new Error(`write failed: ${path}`);
		return st;
	}

	async trash(path: string): Promise<void> {
		const f = this.file(path);
		if (f) await this.app.fileManager.trashFile(f);
	}
}

export function humanError(e: unknown): string {
	const m = e instanceof Error ? e.message : String(e);
	const rules: [RegExp, string][] = [
		[/can't decrypt names/, T.errWrongPassword],
		[/login expired or revoked/, T.errLoginExpired],
		[/access denied/, T.errAccessDenied],
		[/code expired/, T.errCodeExpired],
		[/Google Drive 403/, T.errForbidden],
		[/Google Drive 5\d\d|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ERR_NETWORK|offline|timed out/i, T.errOffline],
	];
	return rules.find(([re]) => re.test(m))?.[1] ?? m;
}

export function globs(text: string): RegExp[] {
	return text
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((g) => {
			const re = g
				.split('')
				.map((c) => (/[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c))
				.join('')
				.replace(/\*\*/g, '.*')
				.replace(/\*/g, '[^/]*')
				.replace(/\?/g, '[^/]');
			return new RegExp(`^${re}(/|$)`);
		});
}

export function parseRawRegex(text: string): RegExp[] {
	return text
		.split('\n')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((pattern) => {
			try {
				return new RegExp(pattern);
			} catch {
				return null;
			}
		})
		.filter((r): r is RegExp => r !== null);
}

class AlertModal extends Modal {
	private message: string;

	constructor(app: App, title: string, message: string) {
		super(app);
		this.setTitle(title);
		this.message = message;
	}

	onOpen() {
		const el = this.contentEl;
		el.createEl('p', { text: this.message, cls: 'cds-pre-line' });
		new Setting(el).addButton((b) =>
			b
				.setButtonText(T.close)
				.setCta()
				.onClick(() => this.close()),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class TextModal extends Modal {
	constructor(app: App, title: string, text: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('pre', { text, cls: 'cds-pre' });
	}
}

class ConfirmModal extends Modal {
	private ok = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, title: string, text: string, button: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('p', { text });
		new Setting(this.contentEl)
			.addButton((b) =>
				b
					.setButtonText(button)
					.setCta()
					.onClick(() => {
						this.ok = true;
						this.close();
					}),
			)
			.addButton((b) => b.setButtonText(T.cancel).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onClose() {
		this.resolve?.(this.ok);
	}
}

class PlanModal extends Modal {
	private result = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, p: Plan, canApply: boolean) {
		super(app);
		this.setTitle(p.reconcile ? T.reconcilePlanTitle : T.planTitle);
		const el = this.contentEl;
		if (p.reconcile) el.createEl('p', { text: T.reconcilePlanDesc, cls: 'cds-backup-meta' });
		if (p.blocked) el.createEl('p', { text: T.stopped(p.blocked), cls: 'mod-warning' });
		for (const w of p.warnings) el.createEl('p', { text: `\u26a0 ${w}` });
		const visibleActions = p.actions.filter((a) => a.type !== 'adopt');
		if (!visibleActions.length) el.createEl('p', { text: T.planNothing });
		for (const type of Object.keys(T.actions) as (keyof typeof T.actions)[]) {
			const paths = visibleActions.filter((a) => a.type === type).map((a) => a.path);
			if (!paths.length) continue;
			const d = el.createEl('details');
			d.createEl('summary', { text: `${T.actions[type]}: ${paths.length}` });
			d.createEl('pre', {
				text: paths.slice(0, 500).join('\n') + (paths.length > 500 ? `\n${T.more(paths.length - 500)}` : ''),
				cls: 'cds-pre',
			});
		}
		const s = new Setting(el);
		if (canApply && visibleActions.length)
			s.addButton((b) =>
				b
					.setButtonText(T.planApply)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.result = true;
						this.close();
					}),
			);
		s.addButton((b) => b.setButtonText(canApply ? T.cancel : T.close).onClick(() => this.close()));
	}

	ask(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onClose() {
		this.resolve?.(this.result);
	}
}

class LoginModal extends Modal {
	private abort = new AbortController();
	private token = '';
	private resolve?: (token: string) => void;
	private clientId: string;
	private clientSecret: string;

	constructor(app: App, clientId: string, clientSecret: string) {
		super(app);
		this.clientId = clientId;
		this.clientSecret = clientSecret;
		this.setTitle(T.loginTitle);
	}

	ask(): Promise<string> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	async onOpen() {
		const el = this.contentEl;
		const status = el.createEl('p', { text: T.loginGettingCode });
		const code = el.createDiv({ cls: 'cds-code' });
		const buttons = new Setting(el);
		let pasted = '';
		new Setting(el)
			.setName(T.loginPaste)
			.setDesc(T.loginPasteDesc)
			.addText((t) =>
				t.onChange((v) => {
					pasted = v;
				}),
			)
			.addButton((b) =>
				b.setButtonText(T.save).onClick(() => {
					this.token = parseRefreshToken(pasted);
					if (this.token) this.close();
				}),
			);

		try {
			const login = await startDeviceLogin(req, this.clientId);
			status.setText(T.loginYourCode);
			code.setText(login.userCode);
			buttons.addButton((b) =>
				b
					.setButtonText(T.loginButton)
					.setCta()
					.onClick(() => {
						navigator.clipboard.writeText(login.userCode).catch(() => status.setText(T.loginCopyFailed));
						window.open(login.verificationUrl);
						status.setText(T.loginCopied);
					}),
			);
			this.token = await pollDeviceLogin(req, this.clientId, this.clientSecret, login, this.abort.signal);
			this.close();
		} catch (e) {
			if (!this.abort.signal.aborted) status.setText(T.error(humanError(e)));
		}
	}

	onClose() {
		this.abort.abort();
		this.contentEl.empty();
		this.resolve?.(this.token);
	}
}

class ImportConfigModal extends Modal {
	private onSubmit: (rawJson: string) => Promise<void>;
	private initialValue: string;

	constructor(app: App, onSubmit: (rawJson: string) => Promise<void>, initialValue = '') {
		super(app);
		this.onSubmit = onSubmit;
		this.initialValue = initialValue;
		this.setTitle('Import configuration payload');
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', {
			text: this.initialValue
				? 'Configuration loaded from qr code (and copied to clipboard). Review or tap "import & apply":'
				: 'Paste your exported configuration JSON or scanned qr payload string below:',
		});

		let textValue = this.initialValue;
		new Setting(contentEl).addTextArea((text) =>
			text
				.setPlaceholder('{"v":1,"s":{...},"sec":{...}}')
				.setValue(this.initialValue)
				.onChange((val) => {
					textValue = val;
				}),
		);

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText('Import & apply')
					.setCta()
					.onClick(async () => {
						if (!textValue.trim()) return;
						this.close();
						await this.onSubmit(textValue.trim());
					}),
			)
			.addButton((btn) => btn.setButtonText('Cancel').onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}
