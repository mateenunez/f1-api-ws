import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

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

  constructor(private pool: any) {}

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
