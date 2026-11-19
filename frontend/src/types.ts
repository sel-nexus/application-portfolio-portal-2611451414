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
export interface PortfolioPayload {
  name: string; owner: string; description: string; productArea: string; status: 'Active' | 'Archived';
}
export interface PortfolioSummary extends PortfolioPayload {
  id: string; applicationCount: number; qualityScore: number;
}
export interface PortfolioDetail extends PortfolioSummary {
  applications: { id: string; name: string }[];
}
export interface PortfolioPage extends PageResult<PortfolioSummary> {
  productAreas: string[]; statuses: ('Active' | 'Archived')[];
}
export type Criticality = 'Low' | 'Medium' | 'High' | 'Critical';
export type Lifecycle = 'Active' | 'Deprecated' | 'Retired';
export type Risk = 'Low' | 'Medium' | 'High';
export interface ApplicationPayload {
  name: string; portfolioId: string; description: string; productArea: string;
  businessOwner: string; technologyOwner: string; qualityOwner: string;
  criticality: Criticality; tier: number; lifecycle: Lifecycle; technologyStack: string;
  repositoryLink: string; pipelineLink: string; healthScore: number; qualityScore: number;
  automationCoverage: number; unitTestCoverage: number; openDefects: number; openCriticalDefects: number; risk: Risk;
}
export interface ApplicationDetail extends ApplicationPayload { id: string; portfolio: string }
export interface ApplicationPage extends PageResult<ApplicationDetail> {
  portfolios: { id: string; name: string }[]; criticalities: Criticality[]; risks: Risk[]; lifecycles: Lifecycle[];
}

/** Describe the seven read-only dashboard values and scoped navigation choices. */
export interface DashboardMetrics {
  enterpriseQualityScore: number;
  applicationHealth: number;
  automationMaturity: number;
  openCriticalDefects: number;
  applicationsAtRisk: number;
  totalApplications: number;
  totalPortfolios: number;
}
export interface DashboardLink { id: string; name: string }
export interface DashboardResponse {
  metrics: DashboardMetrics;
  portfolioQuality: (DashboardLink & { qualityScore: number })[];
  applicationsAtRisk: (DashboardLink & { applications: DashboardLink[] })[];
  portfolios: DashboardLink[];
  productAreas: string[];
  risks: Risk[];
}
