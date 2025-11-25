import { NextApiRequest, NextApiResponse } from "next";
import { AdminApiAuthService } from "@/src/ee/features/admin-api/server/adminApiAuth";
import {
  handleGetMemberships,
  handleUpdateMembership,
  handleDeleteMembership,
} from "@/src/ee/features/admin-api/server/memberships";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // secure endpoint with admin auth
  if (!AdminApiAuthService.handleAdminAuth(req, res)) return;

  const orgId = req.query.organizationId as string;

  switch (req.method) {
    case "GET":
      return handleGetMemberships(req, res, orgId);
    case "PUT":
      return handleUpdateMembership(req, res, orgId);
    case "DELETE":
      return handleDeleteMembership(req, res, orgId);
    default:
      return res.status(405).json({ error: "Method not allowed" });
  }
}
