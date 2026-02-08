import { Pool } from "pg";

export interface Role {
  id: number;
  name: string;
  cooldown_ms: number;
}

export class RoleService {
  constructor(private pool: Pool) {}

  async getRoleById(id: number) {
    const res = await this.pool.query('SELECT * FROM roles WHERE id = $1', [id]);
    return res.rows[0];
  }

  async updateRoleCooldown(name: string, newCooldown: number) {
    await this.pool.query(
      'UPDATE roles SET cooldown_ms = $1 WHERE name = $2',
      [newCooldown, name]
    );
  }
}