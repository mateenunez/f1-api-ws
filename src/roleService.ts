import { Pool } from "pg";

export interface Role {
  id: number;
  name: string;
}

export class RoleService {
  constructor(private pool: Pool) {}

  async getRoleById(id: number) {
    const res = await this.pool.query('SELECT * FROM roles WHERE id = $1', [id]);
    return res.rows[0];
  }

  async getAllRoles(): Promise<Role[]> {
    const res = await this.pool.query('SELECT id, name FROM roles ORDER BY id');
    return res.rows;
  }

  /**
   * Role IDs that currently receive full telemetry data (transcriptions,
   * translations) over the websocket. Admin-configurable at runtime.
   */
  async getFullDataRoleIds(): Promise<number[]> {
    const res = await this.pool.query(
      'SELECT role_id FROM full_data_roles ORDER BY role_id',
    );
    return res.rows.map((r: any) => r.role_id);
  }

  async setFullDataRoles(roleIds: number[]): Promise<number[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM full_data_roles');
      for (const roleId of roleIds) {
        await client.query(
          'INSERT INTO full_data_roles (role_id) VALUES ($1) ON CONFLICT (role_id) DO NOTHING',
          [roleId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getFullDataRoleIds();
  }
}
