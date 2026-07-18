import Darwin
import Foundation
import OpenClawNativeState

enum DeviceIdentitySQLiteStore {
    private static let maximumLegacyIdentityBytes = 64 * 1024
    private static let maximumLegacyAuthBytes = 4 * 1024 * 1024

    private struct LegacyClaim {
        let source: DeviceIdentityPaths.LegacyIdentitySource
        let data: Data
        let snapshot: LegacyFileSnapshot
        let material: DeviceIdentityMaterial
    }

    private struct LegacyFileSnapshot: Equatable {
        let device: UInt64
        let inode: UInt64
        let size: UInt64
        let modifiedAt: Date?
    }

    private struct LegacyAuthCandidate {
        let data: Data
        let store: DeviceAuthStoreFile
    }

    static func loadOrCreate(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource]) throws -> DeviceIdentity
    {
        do {
            return try self.loadOrCreateNativeState(
                databaseURL: databaseURL,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                legacySources: legacySources)
        } catch let error as OpenClawNativeStateError {
            throw DeviceIdentityStoreError(error.message)
        }
    }

    private static func loadOrCreateNativeState(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource]) throws -> DeviceIdentity
    {
        try self.secureDirectory(destinationStateDirURL)
        let claims = try legacySources.compactMap { try self.claimLegacyIdentity($0) }
        try self.requireConsistentClaims(claims)
        let generatedMaterial = claims.isEmpty ? DeviceIdentityStore.generateMaterial() : nil
        let writeTimestampMs = Int64(Date().timeIntervalSince1970 * 1000)

        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        let authoritative = try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.deviceIdentities)
            let existing = try self.readIdentity(database, key: profile.rawValue)
            let selected: DeviceIdentityMaterial
            if let existing {
                if let migrated = claims.first?.material,
                   !self.hasSameKeyMaterial(migrated, existing)
                {
                    throw DeviceIdentityStoreError(
                        "Legacy device identity conflicts with SQLite identity key " +
                            "\(profile.rawValue); source preserved")
                }
                selected = existing
            } else {
                guard let candidate = claims.first?.material ?? generatedMaterial else {
                    throw DeviceIdentityStoreError("Device identity candidate is unavailable")
                }
                selected = candidate
                try self.insertIdentity(
                    database,
                    key: profile.rawValue,
                    material: selected,
                    updatedAtMs: writeTimestampMs)
            }

            // The row reread under the write transaction is authoritative. Never return generated
            // or migrated key material unless SQLite reports the exact canonical receipt.
            guard let authoritative = try self.readIdentity(database, key: profile.rawValue),
                  authoritative == selected
            else {
                throw DeviceIdentityStoreError("SQLite did not preserve the authoritative device identity")
            }
            try database.ensureCanonicalTable(.deviceIdentities, allowVersionZeroCreation: false)
            return authoritative
        }

        if !claims.isEmpty {
            try self.relocateLegacyAuthIfNeeded(
                claims: claims,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                deviceId: authoritative.identity.deviceId)
            try self.removeClaimedLegacyIdentities(claims)
        }
        return authoritative.identity
    }

    private static func readIdentity(
        _ database: OpenClawNativeStateSQLite,
        key: String) throws -> DeviceIdentityMaterial?
    {
        let statement = try database.prepare("""
        SELECT device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        FROM device_identities
        WHERE identity_key = ?
        """)
        try statement.bindText(key, at: 1)
        let result = try statement.step()
        if result == .done { return nil }
        guard statement.valueType(at: 3) == .integer,
              statement.valueType(at: 4) == .integer,
              statement.int64(at: 4) >= 0
        else {
            throw DeviceIdentityStoreError("SQLite device identity timestamps must be integers")
        }
        let material = try DeviceIdentityStore.material(
            deviceId: statement.requiredText(at: 0, field: "device_id"),
            publicKeyPEM: statement.requiredText(at: 1, field: "public_key_pem"),
            privateKeyPEM: statement.requiredText(at: 2, field: "private_key_pem"),
            createdAtMs: statement.int64(at: 3))
        guard try statement.step() == .done else {
            throw DeviceIdentityStoreError("SQLite returned duplicate device identity keys")
        }
        return material
    }

    private static func insertIdentity(
        _ database: OpenClawNativeStateSQLite,
        key: String,
        material: DeviceIdentityMaterial,
        updatedAtMs: Int64) throws
    {
        let statement = try database.prepare("""
        INSERT INTO device_identities (
          identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        """)
        try statement.bindText(key, at: 1)
        try statement.bindText(material.identity.deviceId, at: 2)
        try statement.bindText(material.publicKeyPEM, at: 3)
        try statement.bindText(material.privateKeyPEM, at: 4)
        try statement.bindInt64(material.identity.createdAtMs, at: 5)
        try statement.bindInt64(updatedAtMs, at: 6)
        guard try statement.step() == .done, database.changes == 1 else {
            throw DeviceIdentityStoreError("SQLite did not insert the device identity")
        }
    }

    private static func claimLegacyIdentity(
        _ source: DeviceIdentityPaths.LegacyIdentitySource) throws -> LegacyClaim?
    {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: source.identityURL.path) else {
            if (try? fileManager.destinationOfSymbolicLink(atPath: source.identityURL.path)) != nil {
                throw DeviceIdentityStoreError("Legacy device identity source must not be a symbolic link")
            }
            return nil
        }
        let before = try self.legacyFileSnapshot(
            source.identityURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyIdentityBytes)
        let data = try Data(contentsOf: source.identityURL, options: [.mappedIfSafe])
        guard data.count <= self.maximumLegacyIdentityBytes else {
            throw DeviceIdentityStoreError("Legacy device identity exceeds the maximum supported size")
        }
        let after = try self.legacyFileSnapshot(
            source.identityURL,
            beneath: source.stateDirURL,
            maximumBytes: self.maximumLegacyIdentityBytes)
        guard before == after, UInt64(data.count) == before.size else {
            throw DeviceIdentityStoreError("Legacy device identity changed while being claimed")
        }
        let material = try DeviceIdentityStore.material(fromLegacyData: data)
        return LegacyClaim(source: source, data: data, snapshot: before, material: material)
    }

    private static func legacyFileSnapshot(
        _ url: URL,
        beneath rootURL: URL,
        maximumBytes: Int) throws -> LegacyFileSnapshot
    {
        try self.requireNoSymlinkTraversal(url, beneath: rootURL)
        let resourceValues = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard resourceValues.isSymbolicLink != true, resourceValues.isRegularFile == true else {
            throw DeviceIdentityStoreError("Legacy device identity source must be a regular non-symbolic file")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let linkCount = attributes[.referenceCount] as? NSNumber,
              linkCount.uint64Value == 1,
              let device = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber,
              let size = attributes[.size] as? NSNumber,
              size.uint64Value <= UInt64(maximumBytes)
        else {
            throw DeviceIdentityStoreError(
                "Legacy device identity source must be a bounded regular file with exactly one link")
        }
        return LegacyFileSnapshot(
            device: device.uint64Value,
            inode: inode.uint64Value,
            size: size.uint64Value,
            modifiedAt: attributes[.modificationDate] as? Date)
    }

    private static func requireNoSymlinkTraversal(_ url: URL, beneath rootURL: URL) throws {
        let root = rootURL.standardizedFileURL
        let candidate = url.standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPrefix) else {
            throw DeviceIdentityStoreError("Legacy device identity path escaped its state directory")
        }
        let relativePath = String(candidate.path.dropFirst(rootPrefix.count))
        let expected = root.resolvingSymlinksInPath()
            .appendingPathComponent(relativePath, isDirectory: false)
            .standardizedFileURL
        guard candidate.resolvingSymlinksInPath().standardizedFileURL == expected else {
            throw DeviceIdentityStoreError("Legacy device identity path must not traverse symbolic links")
        }
    }

    private static func requireConsistentClaims(_ claims: [LegacyClaim]) throws {
        guard let first = claims.first else { return }
        guard claims.dropFirst().allSatisfy({ self.hasSameKeyMaterial($0.material, first.material) }) else {
            throw DeviceIdentityStoreError("Legacy device identity sources conflict; all sources preserved")
        }
    }

    private static func hasSameKeyMaterial(
        _ lhs: DeviceIdentityMaterial,
        _ rhs: DeviceIdentityMaterial) -> Bool
    {
        lhs.identity.deviceId == rhs.identity.deviceId
            && lhs.identity.publicKey == rhs.identity.publicKey
            && lhs.identity.privateKey == rhs.identity.privateKey
    }

    private static func relocateLegacyAuthIfNeeded(
        claims: [LegacyClaim],
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        deviceId: String) throws
    {
        let fileManager = FileManager.default
        let destinationIdentityDirURL = destinationStateDirURL
            .appendingPathComponent("identity", isDirectory: true)
        let destinationAuthURL = destinationIdentityDirURL
            .appendingPathComponent(profile.authFileName, isDirectory: false)
        let sourceAuth = try claims.compactMap { claim -> LegacyAuthCandidate? in
            let source = claim.source
            guard source.stateDirURL.standardizedFileURL != destinationStateDirURL.standardizedFileURL,
                  fileManager.fileExists(atPath: source.authURL.path)
            else { return nil }
            return try self.readDeviceAuth(
                source.authURL,
                beneath: source.stateDirURL,
                deviceId: deviceId)
        }
        if let firstSourceAuth = sourceAuth.first,
           !sourceAuth.dropFirst().allSatisfy({ $0.store == firstSourceAuth.store })
        {
            throw DeviceIdentityStoreError(
                "Legacy device auth sources conflict; all identity sources preserved")
        }
        if fileManager.fileExists(atPath: destinationAuthURL.path) {
            let destinationAuth = try self.readDeviceAuth(
                destinationAuthURL,
                beneath: destinationStateDirURL,
                deviceId: deviceId)
            guard sourceAuth.allSatisfy({ $0.store == destinationAuth.store }) else {
                throw DeviceIdentityStoreError(
                    "Destination device auth differs from legacy auth; identity source preserved")
            }
            return
        }
        guard let selectedAuth = sourceAuth.first else { return }

        // DeviceAuthStore remains file-backed. Copy it when identity ownership moves between
        // Apple containers, but never delete or rewrite the source auth file.
        try self.secureDirectory(destinationIdentityDirURL)
        let temporaryAuthURL = destinationIdentityDirURL.appendingPathComponent(
            ".\(profile.authFileName).identity-migrating-\(UUID().uuidString)",
            isDirectory: false)
        defer { try? fileManager.removeItem(at: temporaryAuthURL) }
        try selectedAuth.data.write(to: temporaryAuthURL, options: [.atomic])
        try self.secureFile(temporaryAuthURL)

        // Publish only complete bytes, and never replace a token another process won first.
        // Foundation rejects atomic + withoutOverwriting, so use Darwin's exclusive rename.
        let renameResult = temporaryAuthURL.path.withCString { sourcePath in
            destinationAuthURL.path.withCString { destinationPath in
                renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        if renameResult != 0 {
            let renameError = errno
            guard renameError == EEXIST else {
                throw DeviceIdentityStoreError(
                    "Could not publish migrated device auth: \(String(cString: strerror(renameError)))")
            }
            let destinationAuth = try self.readDeviceAuth(
                destinationAuthURL,
                beneath: destinationStateDirURL,
                deviceId: deviceId)
            guard destinationAuth.store == selectedAuth.store else {
                throw DeviceIdentityStoreError(
                    "Concurrently created device auth differs from legacy auth; identity source preserved")
            }
            return
        }
        try self.secureFile(destinationAuthURL)
    }

    private static func readDeviceAuth(
        _ url: URL,
        beneath stateDirURL: URL,
        deviceId: String) throws -> LegacyAuthCandidate
    {
        let before = try self.legacyFileSnapshot(
            url,
            beneath: stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        let after = try self.legacyFileSnapshot(
            url,
            beneath: stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        guard before == after, UInt64(data.count) == before.size else {
            throw DeviceIdentityStoreError("Device auth changed during identity migration")
        }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data),
              let normalized = DeviceAuthStore.normalizedStore(decoded),
              normalized.deviceId == deviceId
        else {
            throw DeviceIdentityStoreError(
                "Device auth does not belong to the migrated device identity; source preserved")
        }
        return LegacyAuthCandidate(data: data, store: normalized)
    }

    private static func removeClaimedLegacyIdentities(_ claims: [LegacyClaim]) throws {
        let fileManager = FileManager.default
        for claim in claims {
            guard fileManager.fileExists(atPath: claim.source.identityURL.path) else {
                if (try? fileManager.destinationOfSymbolicLink(atPath: claim.source.identityURL.path)) != nil {
                    throw DeviceIdentityStoreError(
                        "Legacy device identity changed to a symbolic link; source preserved")
                }
                continue
            }
            let snapshot = try self.legacyFileSnapshot(
                claim.source.identityURL,
                beneath: claim.source.stateDirURL,
                maximumBytes: self.maximumLegacyIdentityBytes)
            let current = try Data(contentsOf: claim.source.identityURL, options: [.mappedIfSafe])
            guard snapshot == claim.snapshot, current == claim.data else {
                throw DeviceIdentityStoreError("Legacy device identity changed during migration; source preserved")
            }
        }
        for claim in claims where fileManager.fileExists(atPath: claim.source.identityURL.path) {
            try fileManager.removeItem(at: claim.source.identityURL)
        }
    }

    private static func secureDirectory(_ url: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
    }

    private static func secureFile(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
    }
}
