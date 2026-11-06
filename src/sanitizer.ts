export class PathSanitizer {
    /**
     * Sanitizes remote root path (e.g. " obsidian//sync/ " -> "obsidian/sync")
     */
    static sanitizeRootPath(raw?: string): string {
        if (!raw) return 'obsidian-sync';
        const cleaned = raw.trim().replace(/^[\/\\]+|[\/\\]+$/g, '').replace(/[\/\\]+/g, '/');
        return cleaned || 'obsidian-sync';
    }

    /**
     * Sanitizes vault name for folder path isolation (e.g. "Work/Notes" -> "Work-Notes")
     */
    static sanitizeVaultName(raw?: string, defaultName: string = 'default-vault'): string {
        const input = (raw && raw.trim()) ? raw : defaultName;
        const cleaned = input.trim().replace(/^[\/\\]+|[\/\\]+$/g, '').replace(/[\/\\]+/g, '-');
        return cleaned || 'default-vault';
    }

    /**
     * Guarantees a single leading dot for local backup directories (e.g. "_backups" -> ".backups")
     */
    static sanitizeLocalBackupFolder(raw?: string): string {
        if (!raw) return '.backups';
        let cleaned = raw.trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
        cleaned = cleaned.replace(/^[\._]+/, '');
        return cleaned ? `.${cleaned}` : '.backups';
    }
}