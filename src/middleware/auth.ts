import { NextFunction, Request, Response } from "express";
import { User, UserService } from "../userService";

const ADMIN_ROLE_ID = 3;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Builds the auth middleware pair bound to a UserService instance, since
 * verifying a token requires a DB lookup through it.
 */
export function createAuthMiddleware(userService: UserService) {
  async function requireAuth(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res
        .status(401)
        .json({ success: false, error: "Authorization token required" });
    }

    try {
      const result = await userService.verifyToken(token);
      if (!result) {
        return res.status(401).json({ success: false, error: "Invalid token" });
      }
      req.user = result.user;
      next();
    } catch {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    requireAuth(req, res, () => {
      if (req.user?.role.id !== ADMIN_ROLE_ID) {
        return res
          .status(403)
          .json({ success: false, error: "Admin role required" });
      }
      next();
    });
  }

  return { requireAuth, requireAdmin };
}
