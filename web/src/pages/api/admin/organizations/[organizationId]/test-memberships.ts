import { NextApiRequest, NextApiResponse } from "next";

// Minimal testing endpoint
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const orgId = req.query.organizationId as string;

  res.status(200).json({
    message: "Test endpoint works!",
    organizationId: orgId,
    method: req.method,
  });
}
