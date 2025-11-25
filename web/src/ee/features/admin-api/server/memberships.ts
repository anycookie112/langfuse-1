import { type NextApiRequest, type NextApiResponse } from "next";
import { prisma } from "@langfuse/shared/src/db";
import { Role } from "@langfuse/shared";
import { z } from "zod/v4";
import { sendMembershipInvitationEmail } from "@langfuse/shared/src/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { env } from "@/src/env.mjs";

// Schema for request body validation
const MembershipSchema = z.object({
  userId: z.string(),
  role: z.enum(Role),
});

const CreateMembershipSchema = z.object({
  email: z.string().email(),
  role: z.enum(Role),
  projectId: z.string().optional(),
  projectRole: z.enum(Role).optional(),
});

// Schema for delete request body validation
const DeleteMembershipSchema = z.object({
  userId: z.string(),
});

// GET - Retrieve all organization memberships
export async function handleGetMemberships(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
) {
  const memberships = await prisma.organizationMembership.findMany({
    where: {
      orgId: orgId,
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  return res.status(200).json({
    memberships: memberships.map((membership) => ({
      userId: membership.userId,
      role: membership.role,
      email: membership.user.email,
      name: membership.user.name,
    })),
  });
}

// POST - Invite a user to an organization
export async function handleCreateMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
) {
  const validatedBody = CreateMembershipSchema.safeParse(req.body);
  if (!validatedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: validatedBody.error.issues,
    });
  }

  const { email, role, projectId, projectRole } = validatedBody.data;

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      email: email.toLowerCase(),
    },
  });

  const org = await prisma.organization.findUnique({
    where: {
      id: orgId,
    },
  });

  if (!org) {
    return res.status(404).json({
      error: "Organization not found",
    });
  }

  // Check if project exists if projectId is provided
  const project = projectId
    ? await prisma.project.findFirst({
        where: {
          id: projectId,
          orgId: orgId,
          deletedAt: null,
        },
      })
    : null;

  if (projectId && !project) {
    return res.status(404).json({
      error: "Project not found in this organization",
    });
  }

  if (user) {
    // User exists, check if already a member
    const existingOrgMembership = await prisma.organizationMembership.findFirst({
      where: {
        orgId: orgId,
        userId: user.id,
      },
    });

    if (existingOrgMembership) {
      // User is already a member
      // If only project role is requested (and orgRole is NONE - though schema requires orgRole)
      // For simplicity, if they are already a member, we might just return success or error.
      // The requirement is "add members". If they are already added, maybe we should update?
      // But this is POST.
      // Let's follow the logic: if they are member, and we want to add project role, we can do that.
      // But if they are already member, we should probably return 409 or handle it gracefully.
      // For now, let's return 409 if they are already a member of the org.
      // Unless we want to support adding project roles to existing members via this endpoint?
      // The prompt said "add members into an organization".
      return res.status(409).json({
        error: "User is already a member of this organization",
      });
    }

    // Create org membership
    const orgMembership = await prisma.organizationMembership.create({
      data: {
        userId: user.id,
        orgId: orgId,
        role: role,
      },
    });

    await auditLog({
      resourceType: "orgMembership",
      resourceId: orgMembership.id,
      action: "create",
      orgId: orgId,
      orgRole: role,
      userId: "API", // No user session
      after: orgMembership,
    });

    // Add project role if requested
    if (project && projectRole && projectRole !== Role.NONE) {
      const projectMembership = await prisma.projectMembership.create({
        data: {
          userId: user.id,
          projectId: project.id,
          role: projectRole,
          orgMembershipId: orgMembership.id,
        },
      });

      await auditLog({
        resourceType: "projectMembership",
        resourceId: `${project.id}--${user.id}`,
        action: "create",
        orgId: orgId,
        orgRole: role,
        userId: "API",
        after: projectMembership,
      });
    }

    await sendMembershipInvitationEmail({
      inviterEmail: env.EMAIL_FROM_ADDRESS || "noreply@langfuse.com",
      inviterName: "Organization Admin",
      to: email,
      orgName: org.name,
      orgId: orgId,
      userExists: true,
      env: env,
    });

    return res.status(200).json({
      userId: user.id,
      role: role,
      email: user.email,
      name: user.name,
    });
  } else {
    // User does not exist, create invitation
    // Check if invitation already exists
    const existingInvitation = await prisma.membershipInvitation.findFirst({
      where: {
        email: email.toLowerCase(),
        orgId: orgId,
      },
    });

    if (existingInvitation) {
      return res.status(409).json({
        error: "Invitation already exists for this email",
      });
    }

    const invitation = await prisma.membershipInvitation.create({
      data: {
        orgId: orgId,
        projectId: project && projectRole && projectRole !== Role.NONE ? project.id : null,
        email: email.toLowerCase(),
        orgRole: role,
        projectRole: projectRole && projectRole !== Role.NONE && project ? projectRole : null,
        invitedByUserId: null, // API
      },
    });

    await auditLog({
      resourceType: "membershipInvitation",
      resourceId: invitation.id,
      action: "create",
      orgId: orgId,
      orgRole: role,
      userId: "API",
      after: invitation,
    });

    await sendMembershipInvitationEmail({
      inviterEmail: env.EMAIL_FROM_ADDRESS || "noreply@langfuse.com",
      inviterName: "Organization Admin",
      to: email,
      orgName: org.name,
      orgId: orgId,
      userExists: false,
      env: env,
    });

    return res.status(200).json({
      invitationId: invitation.id,
      email: email,
      role: role,
      status: "PENDING",
    });
  }
}

// PUT - Update or create an organization membership
export async function handleUpdateMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
) {
  const validatedBody = MembershipSchema.safeParse(req.body);
  if (!validatedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: validatedBody.error.issues,
    });
  }

  // Check if user exists
  const user = await prisma.user.findUnique({
    where: {
      id: validatedBody.data.userId,
    },
  });

  if (!user) {
    return res.status(404).json({
      error: "User not found",
    });
  }

  // Upsert the membership
  const membership = await prisma.organizationMembership.upsert({
    where: {
      orgId_userId: {
        orgId,
        userId: validatedBody.data.userId,
      },
    },
    update: {
      role: validatedBody.data.role,
    },
    create: {
      orgId,
      userId: validatedBody.data.userId,
      role: validatedBody.data.role,
    },
  });

  return res.status(200).json({
    userId: membership.userId,
    role: membership.role,
    email: user.email,
    name: user.name,
  });
}

// DELETE - Remove an organization membership
export async function handleDeleteMembership(
  req: NextApiRequest,
  res: NextApiResponse,
  orgId: string,
) {
  const validatedBody = DeleteMembershipSchema.safeParse(req.body);
  if (!validatedBody.success) {
    return res.status(400).json({
      error: "Invalid request body",
      details: validatedBody.error.issues,
    });
  }

  // Delete the membership (using deleteMany to avoid errors on not found)
  await prisma.organizationMembership.deleteMany({
    where: {
      orgId,
      userId: validatedBody.data.userId,
    },
  });

  return res.status(200).json({
    message: "Membership deleted successfully",
    userId: validatedBody.data.userId,
  });
}
