import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { RedisClient } from "./redisClient";

export interface User {
  id: number;
  username: string;
  role: {
    name: string;
    id: number;
  };
  email: string;
  created_at: Date;
}

export class UserService {
  private readonly SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || "10");
  private readonly JWT_SECRET = process.env.JWT_SECRET;
  private readonly RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
  private readonly RESET_COOLDOWN_MS = 2 * 60 * 1000;
  // Caps on top of the per-request cooldown above: bound sustained abuse of
  // a single inbox, and bound one IP spraying requests across many inboxes
  // (the cooldown alone can't stop either — it only throttles rapid-fire
  // requests against one account).
  private readonly RESET_ACCOUNT_LIMIT = 5;
  private readonly RESET_ACCOUNT_WINDOW_S = 24 * 60 * 60;
  private readonly RESET_IP_LIMIT = 5;
  private readonly RESET_IP_WINDOW_S = 60 * 60;

  constructor(
    private pool: any,
    private redis: RedisClient,
  ) {}

  async register(username: string, email: string, passwordPlain: string) {
    email = email.trim().toLowerCase();
    const hash = await bcrypt.hash(passwordPlain, this.SALT_ROUNDS);

    const query = `
      INSERT INTO users (username, email, password_hash, role_id)
      VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = 'base'))
      RETURNING id, username, role_id;
    `;
    const res = await this.pool.query(query, [username, email, hash]);
    const created = res.rows[0];

    const infoQuery = `
      SELECT u.id, u.username, r.name as role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1;
    `;
    const infoRes = await this.pool.query(infoQuery, [created.id]);
    const userData = infoRes.rows[0];

    const user: User = {
      id: userData.id,
      email: userData.email,
      username: userData.username,
      role: {
        id: userData.role_id,
        name: userData.role_name,
      },
      created_at: userData.created_at,
    };

    const token = this.generateToken({
      id: user.id,
      role_name: user.role.name,
    });

    return { user, token };
  }

  async login(email: string, passwordPlain: string) {
    email = email.trim().toLowerCase();
    const userData = await this.findByEmail(email);
    if (!userData) throw new Error("USER_NOT_FOUND");
    const isMatch = await bcrypt.compare(passwordPlain, userData.password_hash);
    if (!isMatch) throw new Error("WRONG_PASSWORD");
    const token = this.generateToken(userData);

    const user: User = {
      id: userData.id,
      email: userData.email,
      username: userData.username,
      role: {
        id: userData.role_id,
        name: userData.role_name,
      },
      created_at: userData.created_at,
    };

    return { user, token };
  }

  /**
   * Generates a reset token for the given email and stores its hash. Returns
   * null (no token issued) when the email doesn't match a user, the
   * account/IP has hit its request cap, or a token was already issued
   * within the cooldown window — callers should still report generic
   * success to the client in every case, to avoid leaking which emails are
   * registered.
   */
  async requestPasswordReset(
    email: string,
    ip: string,
  ): Promise<string | null> {
    email = email.trim().toLowerCase();

    // Counted unconditionally, before the DB lookup, so an attacker probing
    // for valid emails can't distinguish "rate limited" from "no such user"
    // by timing, and so a sweep across many made-up addresses still burns
    // through the IP cap.
    const [acctCount, ipCount] = await Promise.all([
      this.redis.incrWithExpiry(
        `reset:acct:${email}`,
        this.RESET_ACCOUNT_WINDOW_S,
      ),
      this.redis.incrWithExpiry(`reset:ip:${ip}`, this.RESET_IP_WINDOW_S),
    ]);
    if (acctCount > this.RESET_ACCOUNT_LIMIT || ipCount > this.RESET_IP_LIMIT) {
      return null;
    }

    const userData = await this.findByEmail(email);
    if (!userData) return null;

    if (userData.reset_token_expires_at) {
      const issuedAt =
        new Date(userData.reset_token_expires_at).getTime() -
        this.RESET_TOKEN_TTL_MS;
      if (Date.now() - issuedAt < this.RESET_COOLDOWN_MS) return null;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + this.RESET_TOKEN_TTL_MS);

    await this.pool.query(
      `UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3`,
      [tokenHash, expiresAt, userData.id],
    );

    return rawToken;
  }

  async resetPassword(rawToken: string, newPasswordPlain: string): Promise<void> {
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const res = await this.pool.query(
      `SELECT id FROM users WHERE reset_token_hash = $1 AND reset_token_expires_at > NOW()`,
      [tokenHash],
    );
    const userRow = res.rows[0];
    if (!userRow) throw new Error("INVALID_OR_EXPIRED_TOKEN");

    const hash = await bcrypt.hash(newPasswordPlain, this.SALT_ROUNDS);
    await this.pool.query(
      `UPDATE users SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $2`,
      [hash, userRow.id],
    );
  }

  private generateToken(user: any) {
    if (this.JWT_SECRET) {
      return jwt.sign(
        {
          id: user.id,
          role: user.role_name,
        },
        this.JWT_SECRET,
        { expiresIn: "7d" },
      );
    }
  }

  async verifyToken(token: string) {
    if (!this.JWT_SECRET) throw new Error("JWT_SECRET not configured");
    try {
      const decoded = jwt.verify(token, this.JWT_SECRET) as any;

      const query = `
      SELECT u.id, u.username, u.email, u.created_at, r.name as role_name, r.id as role_id
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1;
    `;
      const res = await this.pool.query(query, [decoded.id]);

      if (!res.rows[0]) throw new Error("User not found");

      const userData = res.rows[0];

      const user: User = {
        id: userData.id,
        email: userData.email,
        username: userData.username,
        role: {
          id: userData.role_id,
          name: userData.role_name,
        },
        created_at: userData.created_at,
      };

      return { user, token: this.generateToken(userData) };
    } catch (error) {
      throw new Error("INVALID_TOKEN");
    }
  }

  async findByEmail(email: string) {
    const query = `
      SELECT u.*, r.name as role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE LOWER(u.email) = $1;
    `;
    const res = await this.pool.query(query, [email.toLowerCase()]);
    return res.rows[0];
  }

  async findByUsername(username: string) {
    const query = `
      SELECT u.*, r.name as role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.username = $1;
    `;
    const res = await this.pool.query(query, [username]);
    return res.rows[0];
  }

  async getAllUsersPaginated(page: number, limit: number) {
    const offset = (page - 1) * limit;

    const dataQuery = `
    SELECT u.id, u.username, u.email, u.role_id, u.created_at, r.name as role_name
    FROM users u
    JOIN roles r ON u.role_id = r.id
    ORDER BY u.created_at DESC
    LIMIT $1 OFFSET $2;
  `;

    const countQuery = `SELECT COUNT(*) FROM users;`;

    try {
      const [dataRes, countRes] = await Promise.all([
        this.pool.query(dataQuery, [limit, offset]),
        this.pool.query(countQuery),
      ]);

      return {
        users: dataRes.rows,
        totalCount: parseInt(countRes.rows[0].count),
      };
    } catch (err) {
      console.error("Error at getUsersPaginated:", err);
      throw err;
    }
  }

  async getUsersByRolePaginated(
    roleId: number,
    page: number,
    limit: number,
  ): Promise<{ users: any[]; totalCount: number }> {
    const offset = (page - 1) * limit;

    const dataQuery = `
    SELECT u.id, u.username, u.email, u.role_id, u.created_at, r.name as role_name
    FROM users u 
    JOIN roles r ON u.role_id = r.id 
    WHERE u.role_id = $1
    ORDER BY u.id ASC
    LIMIT $2 OFFSET $3;
  `;

    const countQuery = `
    SELECT COUNT(*) FROM users WHERE role_id = $1;
  `;

    try {
      const [dataRes, countRes] = await Promise.all([
        this.pool.query(dataQuery, [roleId, limit, offset]),
        this.pool.query(countQuery, [roleId]),
      ]);

      return {
        users: dataRes.rows,
        totalCount: parseInt(countRes.rows[0].count, 10),
      };
    } catch (err) {
      console.error("Error at getUsersByRole:", err);
      throw err;
    }
  }

  async deleteUser(userId: number) {
    const query = `DELETE FROM users WHERE id = $1 RETURNING id;`;
    const res = await this.pool.query(query, [userId]);
    return res.rows[0];
  }

  async updateUserRole(userId: number, roleId: number): Promise<any> {
    try {
      const userQuery = "SELECT id FROM users WHERE id = $1";
      const userRes = await this.pool.query(userQuery, [userId]);

      if (userRes.rows.length === 0) {
        return null;
      }

      const roleQuery = "SELECT id FROM roles WHERE id = $1";
      const roleRes = await this.pool.query(roleQuery, [roleId]);

      if (roleRes.rows.length === 0) {
        return null;
      }

      const updateQuery = "UPDATE users SET role_id = $1 WHERE id = $2";
      await this.pool.query(updateQuery, [roleId, userId]);

      const selectQuery =
        "SELECT u.id, u.username, u.email, r.name as role_name FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = $1";
      const updatedUserRes = await this.pool.query(selectQuery, [userId]);

      return updatedUserRes.rows[0] || null;
    } catch (error) {
      throw new Error(
        `Failed to update user role: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
