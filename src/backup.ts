import { Notice } from 'obsidian';
import { zipSync } from 'fflate';
import type CryptDriveSync from './main.ts';
import { T } from './i18n.ts';
import { PathSanitizer } from './sanitizer.ts';

interface RemoteEntry {
    mtime: number;
    size?: number;
}

interface RemoteStorage {
    list(): Promise<{ files: Map<string, RemoteEntry> }>;
    write(path: string, data: Uint8Array, mtime: number): Promise<RemoteEntry>;
    trash(path: string): Promise<void>;
}

export class BackupManager {
    private plugin: CryptDriveSync;
    private readonly backupPattern = /backup-\d{8}-\d{6}\.zip$/;

    constructor(plugin: CryptDriveSync) {
        this.plugin = plugin;
    }

    private getBackupFolder(): string {
        return PathSanitizer.sanitizeLocalBackupFolder(this.plugin.settings.localBackupFolder);
    }

    private getRemoteBackupPath(): string {
        return this.plugin.getRemoteSubsystemPath('_backups');
    }

    async createBackup(): Promise<void> {
        const p = this.plugin;
        if (!p.ready()) {
            new Notice(T.notConfigured('plugin settings'));
            return;
        }

        new Notice(T.backupStarting);
        p.log('Starting vault backup...');

        try {
            const localDir = this.getBackupFolder();

            // 1. Gather vault files and compress into a ZIP archive
            const filesToZip: Record<string, Uint8Array> = {};
            const loadedFiles = p.app.vault.getFiles();

            for (const file of loadedFiles) {
                // Ignore backup directories and auto-generated backup-YYYYMMDD-HHMMSS.zip files
                if (
                    file.path.startsWith(localDir) ||
                    file.path.startsWith('_backups') ||
                    file.path.startsWith('backups') ||
                    this.backupPattern.test(file.path)
                ) {
                    continue;
                }
                const data = new Uint8Array(await p.app.vault.readBinary(file));
                filesToZip[file.path] = data;
            }

            const zipBuffer = zipSync(filesToZip);
            p.log(`Created ZIP snapshot: ${zipBuffer.byteLength} bytes (${Object.keys(filesToZip).length} files)`);

            // 2. Store local unencrypted copy if enabled
            if (p.settings.backupKeepLocal) {
                const localPath = `${localDir}/backup-${this.timestamp()}.zip`;
                
                if (!(await p.app.vault.adapter.exists(localDir))) {
                    await p.app.vault.adapter.mkdir(localDir);
                }
                
                await p.app.vault.adapter.writeBinary(localPath, zipBuffer.buffer);
                p.log(`Saved local backup copy to ${localPath}`);
                await this.pruneLocalBackups(p.settings.maxBackups);
            }

            // 3. Encrypt and upload snapshot to Google Drive
            const crypt = await p.getCrypt();
            if (!crypt) throw new Error(T.needPassword);

            const remote = await p.remote(false, '_backups');
            if (!remote) throw new Error('Remote storage unavailable');

            const mtime = Date.now();
            const filename = `backup-${this.timestamp()}.zip`;
            const tmpPath = `${filename}.tmp`;
            const finalPath = filename;

            // Staged upload as .tmp first
            const entry = await (remote as unknown as RemoteStorage).write(tmpPath, zipBuffer, mtime);

            // 4. Verification Check
            if (!entry || entry.size !== zipBuffer.byteLength) {
                throw new Error('Backup verification failed: uploaded byte size mismatch');
            }

            // 5. Promote staged .tmp file to final path
            await (remote as unknown as RemoteStorage).write(finalPath, zipBuffer, mtime);
            await (remote as unknown as RemoteStorage).trash(tmpPath);
            p.log(`Verified and stored remote backup: ${finalPath}`);

            // 6. Safe Rotation: Prune old remote backups ONLY after verification succeeds
            await this.pruneRemoteBackups(remote as unknown as RemoteStorage, Math.min(Math.max(p.settings.maxBackups, 1), 10));

            new Notice(T.backupSuccess);
            p.log('Vault backup completed successfully.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            p.log(`Backup failed: ${msg}`);
            new Notice(T.backupFailed(msg));
        }
    }

    private timestamp(): string {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    }

        private async pruneRemoteBackups(remote: RemoteStorage, maxCount: number): Promise<void> {
        const listRes = await remote.list();
        const backupFiles: { path: string; mtime: number }[] = [];

        for (const [path, entry] of listRes.files.entries()) {
            if (this.backupPattern.test(path)) {
                backupFiles.push({ path, mtime: entry.mtime });
            }
        }

        // Sort descending by modification time (newest first)
        backupFiles.sort((a, b) => b.mtime - a.mtime);

        if (backupFiles.length > maxCount) {
            const toDelete = backupFiles.slice(maxCount);
            for (const item of toDelete) {
                await remote.trash(item.path);
                this.plugin.log(`Pruned old remote backup: ${item.path}`);
            }
        }
    }

    private async pruneLocalBackups(maxCount: number): Promise<void> {
        const localDir = this.getBackupFolder();
        if (!(await this.plugin.app.vault.adapter.exists(localDir))) return;

        const list = await this.plugin.app.vault.adapter.list(localDir);
        const files: { path: string; mtime: number }[] = [];

        for (const file of list.files) {
            if (this.backupPattern.test(file)) {
                const stat = await this.plugin.app.vault.adapter.stat(file);
                if (stat) files.push({ path: file, mtime: stat.mtime });
            }
        }

        files.sort((a, b) => b.mtime - a.mtime);

        if (files.length > maxCount) {
            const toDelete = files.slice(maxCount);
            for (const item of toDelete) {
                await this.plugin.app.vault.adapter.remove(item.path);
                this.plugin.log(`Pruned old local backup: ${item.path}`);
            }
        }
    }
}