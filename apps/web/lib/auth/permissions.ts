export type AppRole = 'owner' | 'staff' | 'platform-admin';

export type Capability =
  | 'viewOperations'
  | 'editOperations'
  | 'publishAgent'
  | 'changeBilling'
  | 'inviteMembers'
  | 'accessAdmin';

export interface RoleCapabilities {
  viewOperations: boolean;
  editOperations: boolean;
  publishAgent: boolean;
  changeBilling: boolean;
  inviteMembers: boolean;
  accessAdmin: boolean;
}

const ROLE_CAPABILITIES: Readonly<Record<AppRole, Readonly<RoleCapabilities>>> = {
  owner: {
    viewOperations: true,
    editOperations: true,
    publishAgent: true,
    changeBilling: true,
    inviteMembers: true,
    accessAdmin: false,
  },
  staff: {
    viewOperations: true,
    editOperations: true,
    publishAgent: false,
    changeBilling: false,
    inviteMembers: false,
    accessAdmin: false,
  },
  'platform-admin': {
    viewOperations: true,
    editOperations: false,
    publishAgent: false,
    changeBilling: false,
    inviteMembers: false,
    accessAdmin: true,
  },
};

export function getCapabilitiesForRole(role: AppRole): Readonly<RoleCapabilities> {
  return ROLE_CAPABILITIES[role];
}

export function hasCapability(role: AppRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role][capability];
}
