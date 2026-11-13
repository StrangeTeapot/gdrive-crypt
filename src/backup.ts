import { App, ButtonComponent, Modal, Notice, Setting, TFolder, normalizePath } from 'obsidian';
import { unzipSync, zipSync } from 'fflate';
import type CryptDriveSync from './main';
import { PathSanitizer } from './sanitizer';
import type { BaseEntry, RemoteEntry } from './types';

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
	const buf = new ArrayBuffer(u.byteLength);
	new Uint8Array(buf).set(u);
	return buf;
}

const MIN_VALID_MTIME = 315532800000; // 1980-01-01T00:00:00.000Z (MS-DOS epoch start)
const MAX_VALID_MTIME = 4102444800000; // 2100-01-01T00:00:00.000Z

function isValidMtime(mtime: number): boolean {
	return Number.isFinite(mtime) && mtime >= MIN_VALID_MTIME && mtime <= MAX_VALID_MTIME;
}

function buildZipFileOptions(mtime: number): { mtime: number; extra?: Record<number, Uint8Array> } {
	const safeMtime = isValidMtime(mtime) ? mtime : Date.now();
	const unixSeconds = Math.floor(safeMtime / 1000);
	const utExtra = new Uint8Array(5);
	utExtra[0] = 0x01; // Flag bit 0: UTC modification time present
	new DataView(utExtra.buffer).setUint32(1, unixSeconds >>> 0, true);
	return {
		mtime: safeMtime,
		extra: { 0x5455: utExtra },
	};
}

function extractZipMtimes(zipBytes: Uint8Array): Map<string, number> {
	const mtimes = new Map<string, number>();
	if (zipBytes.byteLength < 22) return mtimes;

	const view = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
	const minEocdOffset = Math.max(0, zipBytes.byteLength - 65557);
	let eocdOffset = -1;

	for (let i = zipBytes.byteLength - 22; i >= minEocdOffset; i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			const commentLen = view.getUint16(i + 20, true);
			if (i + 22 + commentLen === zipBytes.byteLength) {
				eocdOffset = i;
				break;
			}
			if (eocdOffset === -1) {
				eocdOffset = i;
			}
		}
	}

	if (eocdOffset === -1) return mtimes;

	const cdSize = view.getUint32(eocdOffset + 12, true);
	const cdOffset = view.getUint32(eocdOffset + 16, true);
	if (cdOffset >= zipBytes.byteLength) return mtimes;

	const cdEnd = Math.min(zipBytes.byteLength, cdOffset + cdSize);
	const decoder = new TextDecoder('utf-8');
	let pos = cdOffset;

	while (pos + 46 <= cdEnd) {
		if (view.getUint32(pos, true) !== 0x02014b50) break;

		const dosTime = view.getUint16(pos + 12, true);
		const dosDate = view.getUint16(pos + 14, true);
		const nameLen = view.getUint16(pos + 28, true);
		const extraLen = view.getUint16(pos + 30, true);
		const commentLen = view.getUint16(pos + 32, true);

		const nameStart = pos + 46;
		const extraStart = nameStart + nameLen;
		const extraEnd = extraStart + extraLen;
		const nextPos = extraEnd + commentLen;
		if (nextPos > zipBytes.byteLength) break;

		const rawName = decoder.decode(zipBytes.subarray(nameStart, extraStart));
		pos = nextPos;

		if (!rawName || rawName.endsWith('/') || rawName.endsWith('\\')) continue;
		const cleanPath = normalizePath(rawName.replace(/\\/g, '/')).normalize('NFC');

		let resolvedMtime: number | undefined;

		// 1. Prefer PKWARE / Info-ZIP Extended Timestamp extra field (0x5455, UTC Unix seconds)
		let ep = extraStart;
		while (ep + 4 <= extraEnd) {
			const headerId = view.getUint16(ep, true);
			const dataSize = view.getUint16(ep + 2, true);
			ep += 4;
			if (ep + dataSize > extraEnd) break;

			if (headerId === 0x5455 && dataSize >= 5) {
				const utFlags = zipBytes[ep]!;
				if ((utFlags & 0x01) !== 0) {
					const unixSeconds = view.getUint32(ep + 1, true);
					const candidateMs = unixSeconds * 1000;
					if (isValidMtime(candidateMs)) {
						resolvedMtime = candidateMs;
					}
				}
			}
			ep += dataSize;
		}

		// 2. Fallback to legacy MS-DOS date/time header for older backup archives
		if (resolvedMtime === undefined && dosDate !== 0) {
			const second = (dosTime & 0x1f) * 2;
			const minute = (dosTime >> 5) & 0x3f;
			const hour = (dosTime >> 11) & 0x1f;
			const day = dosDate & 0x1f;
			const month = (dosDate >> 5) & 0x0f;
			const year = ((dosDate >> 9) & 0x7f) + 1980;

			if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59) {
				const candidateMs = new Date(year, month - 1, day, hour, minute, second).getTime();
				if (isValidMtime(candidateMs)) {
					resolvedMtime = candidateMs;
				}
			}
		}

		if (resolvedMtime !== undefined) {
			mtimes.set(cleanPath, resolvedMtime);
		}
	}

	return mtimes;
}


class ConfirmModal extends Modal {
	private ok = false;
	private resolve?: (ok: boolean) => void;

	constructor(app: App, title: string, text: string, buttonText: string) {
		super(app);
		this.setTitle(title);
		this.contentEl.createEl('p', { text });
		new Setting(this.contentEl)
			.addButton((b: ButtonComponent) =>
				b
					.setButtonText(buttonText)
					.setDestructive()
					.setCta()
					.onClick(() => {
						this.ok = true;
						this.close();
					}),
			)
			.addButton((b: ButtonComponent) => b.setButtonText('Cancel').onClick(() => this.close()));
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

export interface RemoteBackupEntry {
	id: string;
	encryptedName: string;
	decryptedName: string;
	size: number;
	mtime: number;
	deviceName: string;
}

export class BackupManager {
	private plugin: CryptDriveSync;
	private isRestoring = false;

	constructor(plugin: CryptDriveSync) {
		this.plugin = plugin;
	}

	generateBackupName(prefix = 'backup_'): string {
		const rawDevice = this.plugin.settings.deviceName || this.plugin.defaultDeviceName();
		const deviceName = rawDevice.replace(/[^a-zA-Z0-9_-]/g, '_');
		const now = new Date();
		const timestamp = now.toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '');
		return `${prefix}${deviceName}_${timestamp}.zip`;
	}

	async createPreRestoreSnapshot(): Promise<void> {
		try {
			const remote = await this.plugin.remote(true, '_backups');
			if (remote) {
				const { files } = await remote.list();
				for (const [path] of files.entries()) {
					const filename = path.split('/').pop() || path;
					if (filename.startsWith('backup_prerestore_') && filename.endsWith('.zip')) {
						try {
							await remote.trash(filename);
							this.plugin.log(`Replaced previous pre-restore snapshot: ${filename}`);
						} catch (err) {
							this.plugin.log(`\u26a0 Failed to remove old pre-restore snapshot: ${String(err)}`);
						}
					}
				}
			}

			const files = this.plugin.app.vault.getFiles();
			const zipData: Record<string, [Uint8Array, { mtime: number; extra?: Record<number, Uint8Array> }]> = {};

			for (const file of files) {
				const nfcPath = normalizePath(file.path.normalize('NFC'));
				const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
				if (localBackupFolder && (nfcPath === localBackupFolder || nfcPath.startsWith(`${localBackupFolder}/`))) continue;

				const content = new Uint8Array(await this.plugin.app.vault.readBinary(file));
				zipData[nfcPath] = [content, buildZipFileOptions(file.stat.mtime)];
			}

			const zipped = zipSync(zipData);
			const snapshotFileName = this.generateBackupName('backup_prerestore_');

			if (remote) {
				await remote.write(snapshotFileName, zipped, Date.now());
				this.plugin.log(`Saved pre-restore safety snapshot: ${snapshotFileName}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.plugin.log(`\u26a0 Pre-restore snapshot failed: ${msg}`);
		}
	}

	async createBackup(): Promise<void> {
		const notice = new Notice('Creating local & remote vault backup...', 0);
		try {
			const files = this.plugin.app.vault.getFiles();
			const zipData: Record<string, [Uint8Array, { mtime: number; extra?: Record<number, Uint8Array> }]> = {};

			for (const file of files) {
				const nfcPath = normalizePath(file.path.normalize('NFC'));
				const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
				if (localBackupFolder && (nfcPath === localBackupFolder || nfcPath.startsWith(`${localBackupFolder}/`))) continue;

				const content = new Uint8Array(await this.plugin.app.vault.readBinary(file));
				zipData[nfcPath] = [content, buildZipFileOptions(file.stat.mtime)];
			}

			const zipped = zipSync(zipData);
			const backupFileName = this.generateBackupName();

			const localDir = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
			if (localDir) {
				const localPath = normalizePath(`${localDir}/${backupFileName}`);
				if (!(await this.plugin.app.vault.adapter.exists(localDir))) {
					await this.plugin.app.vault.adapter.mkdir(localDir);
				}
				await this.plugin.app.vault.adapter.writeBinary(localPath, toArrayBuffer(zipped));
				this.plugin.log(`Saved local backup copy to ${localPath}`);
			}

			const remote = await this.plugin.remote(true, '_backups');
			if (!remote) {
				notice.hide();
				new Notice('Backup created locally, but remote Google Drive connection is unavailable.');
				return;
			}

			await remote.write(backupFileName, zipped, Date.now());
			notice.hide();
			new Notice(`Backup successfully created: ${backupFileName}`);

			await this.pruneRemoteBackups();
		} catch (e) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Backup failed: ${msg}`);
			this.plugin.log(`\u26a0 Backup error: ${msg}`);
		}
	}

	async listRemoteBackups(): Promise<RemoteBackupEntry[]> {
		const remote = await this.plugin.remote(false, '_backups');
		if (!remote) return [];

		const { files } = await remote.list();
		const entries: RemoteBackupEntry[] = [];

		for (const [path, file] of files.entries()) {
			const filename = path.split('/').pop() || path;
			
			if (!filename.startsWith('backup_') || !filename.endsWith('.zip')) {
				continue;
			}

			let deviceName = 'Unknown';
			const isPreRestore = filename.startsWith('backup_prerestore_');
			if (isPreRestore) {
				const match = filename.match(/^backup_prerestore_([^_]+)_/);
				deviceName = match && match[1] ? `${match[1]} (Pre-restore)` : 'Pre-restore Snapshot';
			} else {
				const match = filename.match(/^backup_([^_]+)_/);
				if (match && match[1]) {
					deviceName = match[1];
				}
			}

			entries.push({
				id: file.id || filename,
				encryptedName: filename,
				decryptedName: filename,
				size: file.size,
				mtime: file.mtime,
				deviceName,
			});
		}

		return entries.sort((a, b) => b.mtime - a.mtime);
	}

	async downloadBackup(entry: RemoteBackupEntry): Promise<string> {
		const remote = await this.plugin.remote(true, '_backups');
		if (!remote) throw new Error('Remote storage unavailable');

		const rawBytes = await remote.read(entry.decryptedName);
		this.plugin.log(`Read ${rawBytes.byteLength} bytes from remote backup ${entry.decryptedName}`);
		const localDir = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
		
		if (localDir && !(await this.plugin.app.vault.adapter.exists(localDir))) {
			await this.plugin.app.vault.adapter.mkdir(localDir);
		}

		const localPath = normalizePath(`${localDir}/${entry.decryptedName}`);
		await this.plugin.app.vault.adapter.writeBinary(localPath, toArrayBuffer(rawBytes));
		return localPath;
	}

	async restoreFromZip(zipBytes: Uint8Array, backupMtime?: number): Promise<void> {
		if (this.isRestoring) return;
		this.isRestoring = true;

		try {
			const zipMtimes = extractZipMtimes(zipBytes);
			const unzipped = unzipSync(zipBytes);
			const app = this.plugin.app;
			const adapter = app.vault.adapter;
			const localBackupFolder = PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);


			// Fetch remote vault files map to construct exact 3-way sync baseline state
			const remoteVault = await this.plugin.remote(false, 'vaults');
			const remoteFiles: Map<string, RemoteEntry> = remoteVault
				? (await remoteVault.list()).files
				: new Map<string, RemoteEntry>();

			const restoredPaths = new Set<string>();
			const restoredDirs = new Set<string>();

			// 1. Collect all normalized file and directory paths present in the backup zip
			for (const relativePath of Object.keys(unzipped)) {
				if (!relativePath) continue;
				const cleanPath = normalizePath(relativePath.replace(/\\/g, '/')).normalize('NFC');
				
				if (relativePath.endsWith('/')) {
					restoredDirs.add(cleanPath);
					continue;
				}
				
				restoredPaths.add(cleanPath);

				const segments = cleanPath.split('/');
				for (let i = 1; i < segments.length; i++) {
					restoredDirs.add(segments.slice(0, i).join('/'));
				}
			}

			// 2. Trash local vault files that are not present in the restored backup
			const currentFiles = app.vault.getFiles();
			const trashedLocalPaths = new Set<string>();
			for (const file of currentFiles) {
				const nfcPath = normalizePath(file.path.normalize('NFC'));
				if (localBackupFolder && (nfcPath === localBackupFolder || nfcPath.startsWith(`${localBackupFolder}/`))) {
					continue;
				}
				if (!restoredPaths.has(nfcPath)) {
					try {
						await app.fileManager.trashFile(file);
						trashedLocalPaths.add(nfcPath);
						this.plugin.log(`Trashed local file not present in backup: ${nfcPath}`);
					} catch (err) {
						this.plugin.log(`\u26a0 Could not trash file ${nfcPath}: ${String(err)}`);
					}
				}
			}

			// 3. Trash local vault folders that are not present in the restored backup (deepest first)
			const allLoaded = app.vault.getAllLoadedFiles();
			const loadedFolders = allLoaded.filter((f): f is TFolder => f instanceof TFolder && f.path !== '/');
			loadedFolders.sort((a, b) => b.path.length - a.path.length);

			for (const folder of loadedFolders) {
				const nfcPath = normalizePath(folder.path.normalize('NFC'));
				if (localBackupFolder && (nfcPath === localBackupFolder || nfcPath.startsWith(`${localBackupFolder}/`))) {
					continue;
				}
				if (!restoredDirs.has(nfcPath)) {
					try {
						await app.fileManager.trashFile(folder);
						this.plugin.log(`Trashed untracked folder not present in backup: ${nfcPath}`);
					} catch (err) {
						this.plugin.log(`\u26a0 Could not trash folder ${nfcPath}: ${String(err)}`);
					}
				}
			}

			// 4. Extract and replace/create files in vault and align baseline mtime/md5
			const newBase = new Map<string, BaseEntry>();

			for (const [relativePath, content] of Object.entries(unzipped)) {
				if (!content || relativePath.endsWith('/')) continue;

				const cleanPath = normalizePath(relativePath.replace(/\\/g, '/')).normalize('NFC');
				if (localBackupFolder && (cleanPath === localBackupFolder || cleanPath.startsWith(`${localBackupFolder}/`))) {
					continue;
				}

				const segments = cleanPath.split('/');
				let currentDir = '';
				for (let i = 0; i < segments.length - 1; i++) {
					currentDir = currentDir ? `${currentDir}/${segments[i]}` : segments[i]!;
					if (!(await adapter.exists(currentDir))) {
						await adapter.mkdir(currentDir);
					}
				}

				const buffer = toArrayBuffer(content);
				const restoredMtime = zipMtimes.get(cleanPath);
				if (restoredMtime !== undefined) {
					await adapter.writeBinary(cleanPath, buffer, { mtime: restoredMtime });
				} else {
					await adapter.writeBinary(cleanPath, buffer);
				}

				const stat = await adapter.stat(cleanPath);
				if (stat) {
					const rEntry = remoteFiles.get(cleanPath);
					if (rEntry) {
						const changedSinceBackup =
							stat.size !== rEntry.size || (backupMtime !== undefined && rEntry.mtime > backupMtime + 2000);
						newBase.set(cleanPath, {
							mtime: changedSinceBackup ? 0 : stat.mtime,
							size: changedSinceBackup ? rEntry.size : stat.size,
							md5: rEntry.md5,
						});
					}
				}
			}

			// 5. Seed baseline entries for trashed files matching remote info so plan() evaluates local (deleted) vs remote as TRASH_REMOTE
			for (const trashedPath of trashedLocalPaths) {
				if (!newBase.has(trashedPath)) {
					const rEntry = remoteFiles.get(trashedPath);
					if (rEntry) {
						newBase.set(trashedPath, {
							mtime: rEntry.mtime,
							size: rEntry.size,
							md5: rEntry.md5,
						});
					}
				}
			}

			// 6. Save new baseline state
			await this.plugin.setBase(newBase);

			this.plugin.log('Vault file restoration finished successfully.');
		} finally {
			this.isRestoring = false;
		}
	}

	async deleteRemoteBackup(entry: RemoteBackupEntry): Promise<void> {
		const remote = await this.plugin.remote(true, '_backups');
		if (!remote) throw new Error('Remote storage unavailable');
		await remote.trash(entry.decryptedName);
	}

	private async pruneRemoteBackups(): Promise<void> {
		const maxKeep = Number(this.plugin.settings.maxBackups || 5);
		if (maxKeep <= 0) return;

		const remote = await this.plugin.remote(false, '_backups');
		if (!remote) return;

		const { files } = await remote.list();
		const regularBackups: RemoteBackupEntry[] = [];

		for (const [path, file] of files.entries()) {
			const filename = path.split('/').pop() || path;
			
			if (!filename.startsWith('backup_') || filename.startsWith('backup_prerestore_') || !filename.endsWith('.zip')) {
				continue;
			}

			let deviceName = 'Unknown';
			const match = filename.match(/^backup_([^_]+)_/);
			if (match && match[1]) {
				deviceName = match[1];
			}

			regularBackups.push({
				id: file.id || filename,
				encryptedName: filename,
				decryptedName: filename,
				size: file.size,
				mtime: file.mtime,
				deviceName,
			});
		}

		regularBackups.sort((a, b) => b.mtime - a.mtime);

		if (regularBackups.length > maxKeep) {
			const toDelete = regularBackups.slice(maxKeep);
			for (const entry of toDelete) {
				try {
					await this.deleteRemoteBackup(entry);
					this.plugin.log(`Pruned old remote backup: ${entry.decryptedName}`);
				} catch (e) {
					this.plugin.log(`\u26a0 Failed to prune backup ${entry.decryptedName}: ${String(e)}`);
				}
			}
		}
	}
}

export class RemoteBackupsModal extends Modal {
	private plugin: CryptDriveSync;
	private manager: BackupManager;

	constructor(plugin: CryptDriveSync, manager: BackupManager) {
		super(plugin.app);
		this.plugin = plugin;
		this.manager = manager;
		this.setTitle('Remote backup explorer');
	}

	async onOpen() {
		await this.render();
	}

	async render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Loading available remote backups from Google Drive...', cls: 'cds-log-loading' });

		try {
			const backups = await this.manager.listRemoteBackups();
			contentEl.empty();

			const topContainer = contentEl.createDiv({ cls: 'cds-backup-header' });

			topContainer.createSpan({
				text: `Remote storage: ${backups.length} backup archive(s) available.`,
				cls: 'cds-backup-count',
			});

			new Setting(topContainer)
				.addButton((btn: ButtonComponent) =>
					btn
						.setButtonText('+ create new backup')
						.setCta()
						.onClick(async () => {
							this.close();
							await this.manager.createBackup();
						}),
				)
				.addButton((btn: ButtonComponent) =>
					btn.setButtonText('Refresh').onClick(() => {
						void this.render();
					}),
				);

			if (backups.length === 0) {
				contentEl.createEl('p', { text: 'No remote backups found on Google Drive.', cls: 'cds-empty-msg' });
				return;
			}

			const listEl = contentEl.createDiv({ cls: 'cds-backup-list' });

			for (const item of backups) {
				const row = listEl.createDiv({ cls: 'cds-backup-item' });

				const infoEl = row.createDiv({ cls: 'cds-backup-info' });
				infoEl.createEl('strong', { text: item.decryptedName });

				const mbSize = (item.size / (1024 * 1024)).toFixed(2);
				const dateStr = new Date(item.mtime).toLocaleString();

				infoEl.createDiv({
					text: `Device: ${item.deviceName} | Size: ${mbSize} MB | Date: ${dateStr}`,
					cls: 'cds-backup-meta',
				});

				const actionsEl = row.createDiv({ cls: 'cds-backup-actions' });

				const dlBtn = new ButtonComponent(actionsEl);
				dlBtn.setButtonText('Download').onClick(async () => {
					dlBtn.setDisabled(true);
					const notice = new Notice(`Downloading ${item.decryptedName}...`, 0);
					try {
						const path = await this.manager.downloadBackup(item);
						notice.hide();
						new Notice(`Downloaded to local storage: ${path}`);
					} catch (e) {
						notice.hide();
						new Notice(`Download failed: ${String(e)}`);
					} finally {
						dlBtn.setDisabled(false);
					}
				});

				const restoreBtn = new ButtonComponent(actionsEl);
				restoreBtn
					.setButtonText('Restore vault')
					.onClick(async () => {
						const confirmed = await new ConfirmModal(
							this.app,
							'Restore vault',
							`Are you sure you want to restore vault files from "${item.decryptedName}"? This will overwrite existing files in your vault.`,
							'Restore',
						).ask();
						if (!confirmed) return;

						this.close();
						const isPreRestore = item.decryptedName.startsWith('backup_prerestore_');
						
						try {
							if (!isPreRestore && this.plugin.settings.createPreRestoreSnapshot) {
								const snapshotNotice = new Notice('Creating pre-restore safety snapshot...', 0);
								await this.manager.createPreRestoreSnapshot();
								snapshotNotice.hide();
							} else if (!isPreRestore && !this.plugin.settings.createPreRestoreSnapshot) {
								this.plugin.log('Pre-restore safety snapshot disabled in settings: skipping snapshot creation.');
							} else {
								this.plugin.log('Restoring from pre-restore snapshot: skipping secondary safety snapshot creation.');
							}

							const notice = new Notice('Fetching and extracting remote backup...', 0);
							const remote = await this.plugin.remote(true, '_backups');
							if (!remote) throw new Error('Remote connection unavailable');

							const rawBytes = await remote.read(item.decryptedName);
							await this.manager.restoreFromZip(rawBytes, item.mtime);
							notice.hide();

							new Notice('Vault restoration complete! Reloading workspace...');
							window.setTimeout(() => {
								(this.plugin.app as unknown as { commands: { executeCommandById: (id: string) => void } }).commands.executeCommandById(
									'app:reload',
								);
							}, 1000);
						} catch (e) {
							new Notice(`Restore failed: ${String(e)}`);
						}
					});

				const deleteBtn = new ButtonComponent(actionsEl);
				deleteBtn
					.setButtonText('Delete')
					.setDestructive()
					.onClick(async () => {
						const confirmed = await new ConfirmModal(
							this.app,
							'Delete remote backup',
							`Are you sure you want to delete remote backup "${item.decryptedName}" from Google Drive?`,
							'Delete',
						).ask();
						if (!confirmed) return;

						try {
							await this.manager.deleteRemoteBackup(item);
							new Notice('Remote backup deleted.');
							await this.render();
						} catch (e) {
							new Notice(`Deletion failed: ${String(e)}`);
						}
					});
			}
		} catch (e) {
			contentEl.empty();
			contentEl.createEl('p', { text: `Failed to load remote backups: ${String(e)}`, cls: 'mod-warning' });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
