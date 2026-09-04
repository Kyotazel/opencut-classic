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
