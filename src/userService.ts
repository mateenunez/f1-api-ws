import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

export interface User {
  id: number;
  username: string;
  role_id: string;
  email: string;
  created_at: Date;
}

export class UserService {
  private readonly SALT_ROUNDS = 10;
  private readonly JWT_SECRET = process.env.JWT_SECRET;

  constructor(private pool: any) {}

  async register(username: string, email: string, passwordPlain: string) {
    const hash = await bcrypt.hash(passwordPlain, this.SALT_ROUNDS);

    const query = `
      INSERT INTO users (username, email, password_hash, role_id)
      VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = 'base'))
      RETURNING id, username, role_id;
    `;
    const res = await this.pool.query(query, [username, email, hash]);
    return res.rows[0];
  }

  async login(email: string, passwordPlain: string) {
    const user = await this.findByEmail(email);
    if (!user) throw new Error("Usuario no encontrado");
    const isMatch = await bcrypt.compare(passwordPlain, user.password_hash);
    if (!isMatch) throw new Error("Contraseña incorrecta");
    const token = this.generateToken(user);

    return {
      user: { id: user.id, username: user.username, role: user.role_name },
      token,
    };
  }

  private generateToken(user: any) {
    if (this.JWT_SECRET) {
      return jwt.sign(
        {
          id: user.id,
          role: user.role_name,
          cooldown: user.cooldown_ms,
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
      SELECT u.id, u.username, r.name as role, r.cooldown_ms, r.can_be_anonymous
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.id = $1;
    `;
      const res = await this.pool.query(query, [decoded.id]);

      if (!res.rows[0]) throw new Error("User not found");

      const userData = res.rows[0];

      const user = {
        id: userData.id,
        username: userData.username,
        role: {
          name: userData.role,
          cooldown_ms: userData.cooldown_ms,
          can_be_anonymous: userData.can_be_anonymous,
        },
      };

      return user;
    } catch (error) {
      throw new Error("Invalid or corrupt token");
    }
  }

  async findByEmail(email: string) {
    const query = `
      SELECT u.*, r.name as role_name, r.cooldown_ms, r.can_be_anonymous 
      FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE u.email = $1;
    `;
    const res = await this.pool.query(query, [email]);
    return res.rows[0];
  }

  async getAllUsers() {
    const query = `
      SELECT u.id, u.username, u.email, u.created_at, r.name as role_name
      FROM users u
      JOIN roles r ON u.role_id = r.id
      ORDER BY u.created_at DESC;
    `;
    const res = await this.pool.query(query);
    return res.rows;
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
