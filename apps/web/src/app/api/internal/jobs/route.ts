import { mountExecutor } from '../../../../../../../ops/maintenance/mount.mts';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
// Scheduling and feature handler registration require their actual producer
// authorizers. No credential or schedule can substitute for that composition.
export const POST = mountExecutor(null);
