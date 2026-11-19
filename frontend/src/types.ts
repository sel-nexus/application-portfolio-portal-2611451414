/** Define the identity boundary shared by pages, shell, and HTTP consumers. */
export type Landing = 'Dashboard' | 'Applications';
export type RoleName = 'Administrator' | 'Executive' | 'Portfolio Leader' | 'Engineer' | 'Auditor' | 'Read Only';
export interface User {
  id: string; name: string; email: string; role: RoleName; permissions: string[];
  portfolioAccess: string[]; portfolioNames: string[]; status: 'Active' | 'Inactive';
  managerName: string; vendor: boolean; mustChangePassword: boolean;
  defaultLanding: Landing; lastSignIn: string | null;
}
export interface Session { token: string; user: User }
export interface PasswordPayload { currentPassword: string; newPassword: string; confirmation: string }
export interface PageResult<T> { items: T[]; total: number; page: number; page_size: number }
