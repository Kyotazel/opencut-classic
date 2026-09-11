import {
	mysqlTable,
	text,
	timestamp,
	boolean,
	varchar,
	double,
	int,
	mysqlEnum,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
	id: varchar("id", { length: 64 }).primaryKey(),

	// todo: implement fully anonymous sign-in for privacy
	// we don't have any auth flows currently so this is fine for now
	name: text("name").notNull(),
	email: varchar("email", { length: 255 }).notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const sessions = mysqlTable("sessions", {
	id: varchar("id", { length: 64 }).primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
	token: varchar("token", { length: 255 }).notNull().unique(),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: varchar("user_id", { length: 64 })
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = mysqlTable("accounts", {
	id: varchar("id", { length: 64 }).primaryKey(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: varchar("user_id", { length: 64 })
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
});

export const feedback = mysqlTable("feedback", {
	id: varchar("id", { length: 64 }).primaryKey(),
	message: text("message").notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export const klipMedia = mysqlTable("klip_media", {
	id: varchar("id", { length: 64 }).primaryKey(),
	kind: mysqlEnum("kind", ["source", "brand"]).notNull(),
	assetKind: mysqlEnum("asset_kind", ["image", "video", "audio"]),
	name: varchar("name", { length: 255 }).notNull(),
	filePath: varchar("file_path", { length: 1024 }).notNull(),
	width: int("width"),
	height: int("height"),
	duration: double("duration"),
	thumbnailPath: varchar("thumbnail_path", { length: 1024 }),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipMedia = typeof klipMedia.$inferSelect;

export const klipProjects = mysqlTable("klip_projects", {
	id: varchar("id", { length: 64 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	batchId: varchar("batch_id", { length: 64 }),
	sourceMediaId: varchar("source_media_id", { length: 64 }),
	caption: text("caption"),
	status: varchar("status", { length: 32 }).default("ready").notNull(),
	opencutRef: varchar("opencut_ref", { length: 64 }),
	duration: double("duration"),
	width: int("width"),
	height: int("height"),
	fps: double("fps"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipProject = typeof klipProjects.$inferSelect;

export const klipBrandLayers = mysqlTable("klip_brand_layers", {
	id: varchar("id", { length: 64 }).primaryKey(),
	// Inline FK so mysql-core emits ON DELETE CASCADE in the DDL.
	projectId: varchar("project_id", { length: 64 })
		.notNull()
		.references(() => klipProjects.id, { onDelete: "cascade" }),
	assetId: varchar("asset_id", { length: 64 }),
	filePath: varchar("file_path", { length: 1024 }).notNull(),
	name: varchar("name", { length: 255 }).notNull(),
	kind: mysqlEnum("kind", ["image", "video", "audio"]).notNull(),
	enabled: boolean("enabled").default(true).notNull(),
	x: double("x").default(0.06).notNull(),
	y: double("y").default(0.05).notNull(),
	scale: double("scale").default(0.36).notNull(),
	rotate: double("rotate").default(0).notNull(),
	opacity: int("opacity").default(100).notNull(),
	full: boolean("full").default(true).notNull(),
	// "main_end" = layer selalu mulai tepat saat video utama habis (post-roll).
	anchor: mysqlEnum("anchor", ["start", "main_end"]).default("start").notNull(),
	start: double("start").default(0).notNull(),
	dur: double("dur").default(0).notNull(),
	volume: double("volume").default(0.35).notNull(),
	duck: boolean("duck").default(false).notNull(),
	z: int("z").default(0).notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipBrandLayer = typeof klipBrandLayers.$inferSelect;

export const klipBrandTemplates = mysqlTable("klip_brand_templates", {
	id: varchar("id", { length: 64 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipBrandTemplate = typeof klipBrandTemplates.$inferSelect;

export const klipBrandTemplateLayers = mysqlTable("klip_brand_template_layers", {
	id: varchar("id", { length: 64 }).primaryKey(),
	// Inline FK agar DDL memuat ON DELETE CASCADE (pola klipBrandLayers.projectId).
	templateId: varchar("template_id", { length: 64 })
		.notNull()
		.references(() => klipBrandTemplates.id, { onDelete: "cascade" }),
	assetId: varchar("asset_id", { length: 64 }),
	filePath: varchar("file_path", { length: 1024 }).notNull(),
	name: varchar("name", { length: 255 }).notNull(),
	kind: mysqlEnum("kind", ["image", "video", "audio"]).notNull(),
	enabled: boolean("enabled").default(true).notNull(),
	anchor: mysqlEnum("anchor", ["start", "main_end"]).default("start").notNull(),
	x: double("x").default(0.06).notNull(),
	y: double("y").default(0.05).notNull(),
	scale: double("scale").default(0.36).notNull(),
	rotate: double("rotate").default(0).notNull(),
	opacity: int("opacity").default(100).notNull(),
	full: boolean("full").default(true).notNull(),
	start: double("start").default(0).notNull(),
	dur: double("dur").default(0).notNull(),
	volume: double("volume").default(0.35).notNull(),
	duck: boolean("duck").default(false).notNull(),
	z: int("z").default(0).notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipBrandTemplateLayer = typeof klipBrandTemplateLayers.$inferSelect;

export const verifications = mysqlTable("verifications", {
	id: varchar("id", { length: 64 }).primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
	updatedAt: timestamp("updated_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
});

export const klipIgAccounts = mysqlTable("klip_ig_accounts", {
	id: varchar("id", { length: 64 }).primaryKey(),
	igUserId: varchar("ig_user_id", { length: 64 }).notNull().unique(),
	username: varchar("username", { length: 255 }).notNull(),
	profilePicUrl: text("profile_pic_url"),
	accessTokenEnc: text("access_token_enc").notNull(),
	tokenExpiresAt: timestamp("token_expires_at"),
	status: mysqlEnum("status", ["active", "token_expired", "disconnected"])
		.default("active")
		.notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipIgAccount = typeof klipIgAccounts.$inferSelect;

export const klipIgPublishes = mysqlTable("klip_ig_publishes", {
	id: varchar("id", { length: 64 }).primaryKey(),
	projectId: varchar("project_id", { length: 64 })
		.notNull()
		.references(() => klipProjects.id, { onDelete: "cascade" }),
	caption: text("caption"),
	videoPath: varchar("video_path", { length: 1024 }).notNull(),
	status: mysqlEnum("status", ["processing", "done", "partial", "failed"])
		.default("processing")
		.notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipIgPublish = typeof klipIgPublishes.$inferSelect;

export const klipIgPublishItems = mysqlTable("klip_ig_publish_items", {
	id: varchar("id", { length: 64 }).primaryKey(),
	publishId: varchar("publish_id", { length: 64 })
		.notNull()
		.references(() => klipIgPublishes.id, { onDelete: "cascade" }),
	igAccountId: varchar("ig_account_id", { length: 64 })
		.notNull()
		.references(() => klipIgAccounts.id, { onDelete: "cascade" }),
	containerId: varchar("container_id", { length: 128 }),
	status: mysqlEnum("status", [
		"queued",
		"uploading",
		"processing",
		"published",
		"failed",
	])
		.default("queued")
		.notNull(),
	permalink: text("permalink"),
	error: text("error"),
	attempts: int("attempts").default(0).notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipIgPublishItem = typeof klipIgPublishItems.$inferSelect;

export const klipSyncProjects = mysqlTable("klip_sync_projects", {
	id: varchar("id", { length: 64 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull(),
	data: text("data").notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipSyncProject = typeof klipSyncProjects.$inferSelect;

export const klipSyncMedia = mysqlTable("klip_sync_media", {
	id: varchar("id", { length: 128 }).primaryKey(),
	projectId: varchar("project_id", { length: 64 })
		.notNull()
		.references(() => klipSyncProjects.id, { onDelete: "cascade" }),
	filePath: varchar("file_path", { length: 1024 }).notNull(),
	mime: varchar("mime", { length: 128 }).notNull(),
	size: int("size").notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export type KlipSyncMedia = typeof klipSyncMedia.$inferSelect;
