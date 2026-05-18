import crypto from 'node:crypto';
import { stripTrailingSlash } from '@openpanel/common';
import { hashPassword } from '@openpanel/common/server';
import {
  db,
  getClientByIdCached,
  getId,
  getProjectByIdCached,
} from '@openpanel/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '@/utils/errors';

// Reserved Organization ID for the platform-admin root client.
//
// The openpanel-chart bootstrap Job INSERTs an Organization with this
// id and a root Client anchored to it. The pair acts as a sentinel for
// "this caller is the platform admin": Org handlers below detect the
// id and skip same-org filtering so platform admins can manage every
// tenant Organization.
//
// `createOrganization` refuses to mint a new Org whose slugified id
// would equal this constant, so a tenant named "Platform Admin"
// (which would slug to `platform-admin`) can't accidentally inherit
// god-mode. The bootstrap Job seeds the row directly via SQL and is
// not subject to that reservation.
const PLATFORM_ADMIN_ORG_ID = 'platform-admin';

function isPlatformAdmin(client: { organizationId: string }): boolean {
  return client.organizationId === PLATFORM_ADMIN_ORG_ID;
}

// Validation schemas (exported for use in router)
export const zCreateOrganization = z.object({
  name: z.string().min(1),
  timezone: z.string().optional(),
});

export const zUpdateOrganization = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().optional(),
});

export const zCreateProject = z.object({
  name: z.string().min(1),
  domain: z.string().url().or(z.literal('')).or(z.null()).optional(),
  cors: z.array(z.string()).default([]),
  crossDomain: z.boolean().optional().default(false),
  types: z
    .array(z.enum(['website', 'app', 'backend']))
    .optional()
    .default([]),
});

export const zUpdateProject = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().url().or(z.literal('')).or(z.null()).optional(),
  cors: z.array(z.string()).optional(),
  crossDomain: z.boolean().optional(),
  allowUnsafeRevenueTracking: z.boolean().optional(),
});

export const zCreateClient = z.object({
  name: z.string().min(1),
  projectId: z.string().optional(),
  type: z.enum(['read', 'write', 'root']).optional().default('write'),
});

export const zUpdateClient = z.object({
  name: z.string().min(1).optional(),
});

export const zCreateReference = z.object({
  projectId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  datetime: z.string(),
});

export const zUpdateReference = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  datetime: z.string().optional(),
});

// Projects CRUD
export async function listProjects(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const projects = await db.project.findMany({
    where: {
      organizationId: request.client!.organizationId,
      deleteAt: null,
    },
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: projects });
}

export async function getProject(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const project = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  reply.send({ data: project });
}

export async function createProject(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateProject> }>,
  reply: FastifyReply
) {
  const { name, domain, cors, crossDomain, types } = request.body;

  // Generate a default client secret
  const secret = `sec_${crypto.randomBytes(10).toString('hex')}`;
  const clientData = {
    organizationId: request.client!.organizationId,
    name: 'First client',
    type: 'write' as const,
    secret: await hashPassword(secret),
  };

  const project = await db.project.create({
    data: {
      id: await getId('project', name),
      organizationId: request.client!.organizationId,
      name,
      domain: domain ? stripTrailingSlash(domain) : null,
      cors: cors.map((c) => stripTrailingSlash(c)),
      crossDomain: crossDomain ?? false,
      allowUnsafeRevenueTracking: false,
      filters: [],
      types,
      clients: {
        create: clientData,
      },
    },
    include: {
      clients: {
        select: {
          id: true,
        },
      },
    },
  });

  await Promise.all([
    getProjectByIdCached.clear(project.id),
    ...project.clients.map((client) => getClientByIdCached.clear(client.id)),
  ]);

  reply.send({
    data: {
      ...project,
      client: project.clients[0]
        ? {
            id: project.clients[0].id,
            secret,
          }
        : null,
    },
  });
}

export async function updateProject(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateProject>;
  }>,
  reply: FastifyReply
) {
  const body = request.body;

  // Verify project exists and belongs to organization
  const existing = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
    include: {
      clients: {
        select: {
          id: true,
        },
      },
    },
  });

  if (!existing) {
    throw new HttpError('Project not found', { status: 404 });
  }

  const updateData: any = {};
  if (body.name !== undefined) {
    updateData.name = body.name;
  }
  if (body.domain !== undefined) {
    updateData.domain = body.domain
      ? stripTrailingSlash(body.domain)
      : null;
  }
  if (body.cors !== undefined) {
    updateData.cors = body.cors.map((c) => stripTrailingSlash(c));
  }
  if (body.crossDomain !== undefined) {
    updateData.crossDomain = body.crossDomain;
  }
  if (body.allowUnsafeRevenueTracking !== undefined) {
    updateData.allowUnsafeRevenueTracking = body.allowUnsafeRevenueTracking;
  }

  const project = await db.project.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  await Promise.all([
    getProjectByIdCached.clear(project.id),
    ...existing.clients.map((client) => getClientByIdCached.clear(client.id)),
  ]);

  reply.send({ data: project });
}

export async function deleteProject(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const project = await db.project.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  await db.project.update({
    where: {
      id: request.params.id,
    },
    data: {
      deleteAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await getProjectByIdCached.clear(request.params.id);

  reply.send({ success: true });
}

// ---------------------------------------------------------------------
// Organizations CRUD
//
// Available to /manage callers authenticated via OIDC JWT
// (`platform-admin`-class roles, see apps/api/src/utils/auth.ts) and to
// root-Client callers for read/update/delete of their own organization.
// Creating *new* organizations is realistically only useful to a
// platform-admin caller — root Clients are scoped to one org and can't
// create siblings — but the endpoint doesn't enforce that gate; it
// trusts that whoever has admin auth is permitted by the operator.
// ---------------------------------------------------------------------

export async function listOrganizations(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // Platform-admin sees every Organization on this OpenPanel install
  // (drives the TenantStack composition: discover which tenant Orgs
  // already exist so new tenants don't collide with existing slugs).
  // Tenant-scoped callers see only the org they're anchored to.
  if (isPlatformAdmin(request.client!)) {
    const orgs = await db.organization.findMany({
      orderBy: { name: 'asc' },
    });
    reply.send({ data: orgs });
    return;
  }
  const org = await db.organization.findFirst({
    where: { id: request.client!.organizationId },
  });
  reply.send({ data: org ? [org] : [] });
}

export async function getOrganization(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  // Tenant-scoped callers can only GET the Org their root Client (or
  // synthesized JWT admin client) is anchored to; platform-admin
  // bypasses that filter and can fetch any Org by id.
  //
  // BUG NOTE: an earlier shape of this handler built the `where`
  // clause via an object spread that overrode the URL-param `id`
  // with `client.organizationId`, so GET /manage/organizations/<any-id>
  // silently returned the caller's own Organization. That made TF /
  // Crossplane reconciles see drift and "reconcile" by renaming
  // whichever Org the caller was anchored to. The explicit
  // compare-and-404 below avoids that whole class of mistake.
  if (
    !isPlatformAdmin(request.client!) &&
    request.params.id !== request.client!.organizationId
  ) {
    throw new HttpError('Organization not found', { status: 404 });
  }
  const org = await db.organization.findFirst({
    where: { id: request.params.id },
  });
  if (!org) {
    throw new HttpError('Organization not found', { status: 404 });
  }
  reply.send({ data: org });
}

export async function createOrganization(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateOrganization> }>,
  reply: FastifyReply
) {
  // Only platform-admin can mint new Organizations. A tenant-scoped
  // caller's auth is anchored to one org; a successful Create from
  // such a caller would produce an Org the same caller can't READ
  // back (membership tracking would need to follow), which is the
  // exact mode that caused Crossplane / TF reconciles to silently
  // rename and then cascade-delete the wrong Org.
  if (!isPlatformAdmin(request.client!)) {
    throw new HttpError(
      'Only the platform-admin client can create Organizations. ' +
        'Tenant-scoped callers cannot mint sibling Orgs.',
      { status: 403 },
    );
  }

  const { name, timezone } = request.body;
  const id = await getId('organization', name);

  // Reserve the platform-admin sentinel id. The chart bootstrap Job
  // INSERTs that row directly via SQL; if a real tenant name happened
  // to slug to the same value, that tenant would inherit god-mode on
  // every subsequent request.
  if (id === PLATFORM_ADMIN_ORG_ID) {
    throw new HttpError(
      `Organization id "${PLATFORM_ADMIN_ORG_ID}" is reserved for the platform-admin sentinel client. Pick a different name.`,
      { status: 409 },
    );
  }

  const org = await db.organization.create({
    data: {
      id,
      name,
      timezone: timezone ?? null,
      onboarding: 'completed',
    },
  });
  reply.send({ data: org });
}

export async function updateOrganization(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateOrganization>;
  }>,
  reply: FastifyReply
) {
  // Tenant-scoped callers can only update their own Org; platform-admin
  // can update any (see getOrganization for the original bug).
  if (
    !isPlatformAdmin(request.client!) &&
    request.params.id !== request.client!.organizationId
  ) {
    throw new HttpError('Organization not found', { status: 404 });
  }
  const existing = await db.organization.findFirst({
    where: { id: request.params.id },
  });
  if (!existing) {
    throw new HttpError('Organization not found', { status: 404 });
  }

  const data: { name?: string; timezone?: string | null } = {};
  if (request.body.name !== undefined) data.name = request.body.name;
  if (request.body.timezone !== undefined) {
    data.timezone = request.body.timezone;
  }

  const org = await db.organization.update({
    where: { id: request.params.id },
    data,
  });
  reply.send({ data: org });
}

export async function deleteOrganization(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  // Tenant-scoped callers can only delete their own Org; platform-admin
  // can delete any (see getOrganization for the original bug).
  // Deleting an Org cascades to projects/clients/members; an
  // unscoped delete here was the trigger that cleared the bootstrap
  // root Client during Crossplane MR cleanup.
  if (
    !isPlatformAdmin(request.client!) &&
    request.params.id !== request.client!.organizationId
  ) {
    throw new HttpError('Organization not found', { status: 404 });
  }

  // Refuse to delete the platform-admin Org — destroying it would
  // cascade-delete the platform-admin root Client and lock the
  // operator out of /manage entirely until the chart's bootstrap
  // Job re-runs.
  if (request.params.id === PLATFORM_ADMIN_ORG_ID) {
    throw new HttpError(
      `Organization "${PLATFORM_ADMIN_ORG_ID}" cannot be deleted (would cascade-delete the platform-admin client).`,
      { status: 409 },
    );
  }
  const existing = await db.organization.findFirst({
    where: { id: request.params.id },
  });
  if (!existing) {
    throw new HttpError('Organization not found', { status: 404 });
  }

  await db.organization.delete({
    where: { id: request.params.id },
  });
  reply.send({ success: true });
}

// Clients CRUD
export async function listClients(
  request: FastifyRequest<{ Querystring: { projectId?: string } }>,
  reply: FastifyReply
) {
  const where: any = {
    organizationId: request.client!.organizationId,
  };

  if (request.query.projectId) {
    // Verify project belongs to organization
    const project = await db.project.findFirst({
      where: {
        id: request.query.projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }

    where.projectId = request.query.projectId;
  }

  const clients = await db.client.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: clients });
}

export async function getClient(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const client = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!client) {
    throw new HttpError('Client not found', { status: 404 });
  }

  reply.send({ data: client });
}

export async function createClient(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateClient> }>,
  reply: FastifyReply
) {
  const { name, projectId, type } = request.body;

  // If projectId is provided, verify it belongs to organization
  if (projectId) {
    const project = await db.project.findFirst({
      where: {
        id: projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }
  }

  // Generate secret
  const secret = `sec_${crypto.randomBytes(10).toString('hex')}`;

  const client = await db.client.create({
    data: {
      organizationId: request.client!.organizationId,
      projectId: projectId || null,
      name,
      type: type || 'write',
      secret: await hashPassword(secret),
    },
  });

  await getClientByIdCached.clear(client.id);

  reply.send({
    data: {
      ...client,
      secret, // Return plain secret only once
    },
  });
}

export async function updateClient(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateClient>;
  }>,
  reply: FastifyReply
) {
  // Verify client exists and belongs to organization
  const existing = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!existing) {
    throw new HttpError('Client not found', { status: 404 });
  }

  const updateData: any = {};
  if (request.body.name !== undefined) {
    updateData.name = request.body.name;
  }

  const client = await db.client.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  await getClientByIdCached.clear(client.id);

  reply.send({ data: client });
}

export async function deleteClient(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const client = await db.client.findFirst({
    where: {
      id: request.params.id,
      organizationId: request.client!.organizationId,
    },
  });

  if (!client) {
    throw new HttpError('Client not found', { status: 404 });
  }

  await db.client.delete({
    where: {
      id: request.params.id,
    },
  });

  await getClientByIdCached.clear(request.params.id);

  reply.send({ success: true });
}

// References CRUD
export async function listReferences(
  request: FastifyRequest<{ Querystring: { projectId?: string } }>,
  reply: FastifyReply
) {
  const where: any = {};

  if (request.query.projectId) {
    // Verify project belongs to organization
    const project = await db.project.findFirst({
      where: {
        id: request.query.projectId,
        organizationId: request.client!.organizationId,
      },
    });

    if (!project) {
      throw new HttpError('Project not found', { status: 404 });
    }

    where.projectId = request.query.projectId;
  } else {
    // If no projectId, get all projects in org and filter references
    const projects = await db.project.findMany({
      where: {
        organizationId: request.client!.organizationId,
      },
      select: { id: true },
    });

    where.projectId = {
      in: projects.map((p) => p.id),
    };
  }

  const references = await db.reference.findMany({
    where,
    orderBy: {
      createdAt: 'desc',
    },
  });

  reply.send({ data: references });
}

export async function getReference(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const reference = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reference) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (reference.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  reply.send({ data: reference });
}

export async function createReference(
  request: FastifyRequest<{ Body: z.infer<typeof zCreateReference> }>,
  reply: FastifyReply
) {
  const { projectId, title, description, datetime } = request.body;

  // Verify project belongs to organization
  const project = await db.project.findFirst({
    where: {
      id: projectId,
      organizationId: request.client!.organizationId,
    },
  });

  if (!project) {
    throw new HttpError('Project not found', { status: 404 });
  }

  const reference = await db.reference.create({
    data: {
      projectId,
      title,
      description: description || null,
      date: new Date(datetime),
    },
  });

  reply.send({ data: reference });
}

export async function updateReference(
  request: FastifyRequest<{
    Params: { id: string };
    Body: z.infer<typeof zUpdateReference>;
  }>,
  reply: FastifyReply
) {
  const body = request.body;

  // Verify reference exists and belongs to organization
  const existing = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!existing) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (existing.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  const updateData: any = {};
  if (body.title !== undefined) {
    updateData.title = body.title;
  }
  if (body.description !== undefined) {
    updateData.description = body.description ?? null;
  }
  if (body.datetime !== undefined) {
    updateData.date = new Date(body.datetime);
  }

  const reference = await db.reference.update({
    where: {
      id: request.params.id,
    },
    data: updateData,
  });

  reply.send({ data: reference });
}

export async function deleteReference(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  const reference = await db.reference.findUnique({
    where: {
      id: request.params.id,
    },
    include: {
      project: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reference) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  if (reference.project.organizationId !== request.client!.organizationId) {
    throw new HttpError('Reference not found', { status: 404 });
  }

  await db.reference.delete({
    where: {
      id: request.params.id,
    },
  });

  reply.send({ success: true });
}
