'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/useAuth';
import Sidebar from '@/components/Sidebar';

/* ---------- types ---------- */
interface Section {
  id: string;
  title: string;
  content: React.ReactNode;
}

/* ---------- reusable screenshot / placeholder ---------- */
function GuideScreenshot({ caption, src }: { caption: string; src?: string }) {
  if (src) {
    return (
      <div className="my-4">
        <img src={src} alt={caption} className="w-full rounded-lg border border-gray-200 shadow-sm" />
        <p className="text-xs text-gray-400 mt-1 italic text-center">{caption}</p>
      </div>
    );
  }
  return (
    <div className="my-4 rounded-lg border-2 border-dashed border-gray-300 bg-gray-100 flex flex-col items-center justify-center py-12 px-6 text-center">
      <svg className="w-10 h-10 text-gray-400 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
      </svg>
      <span className="text-sm text-gray-500 italic">[Screenshot: {caption}]</span>
    </div>
  );
}

function InlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="text-[var(--color-primary)] hover:underline font-medium">
      {children}
    </Link>
  );
}

/* ---------- sections ---------- */
function buildSections(): Section[] {
  return [
    {
      id: 'getting-started',
      title: '1. Getting Started',
      content: (
        <>
          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Logging In</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            Navigate to the <InlineLink href="/login">Login page</InlineLink> and enter your email address and password.
            If this is your first time logging in, your administrator will have provided your initial credentials.
          </p>
          <GuideScreenshot caption="Login page with email and password fields" src="/guide/login.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-6 mb-2">Forgot Password</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            If you forget your password, click &quot;Forgot Password?&quot; on the login page. Enter your email and
            a temporary password will be sent to you.
          </p>
          <GuideScreenshot caption="Reset password modal" src="/guide/reset-password.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-6 mb-2">First-Time Password Change</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            On first login you will be prompted to <InlineLink href="/change-password">change your password</InlineLink>.
            Choose a strong password you can remember &mdash; you will not be able to continue until it is updated.
          </p>
          <GuideScreenshot caption="Change password form" src="/guide/change-password.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-6 mb-2">Account Settings</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            Visit <InlineLink href="/account">My Account</InlineLink> to upload a profile photo, change your email address,
            or update your password at any time. You can also upgrade your subscription tier from the Billing section.
          </p>
          <GuideScreenshot caption="Account page showing profile picture, display name, and email sections" src="/guide/account.png" />
        </>
      ),
    },
    {
      id: 'dashboard',
      title: '2. Dashboard',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/dashboard">Dashboard</InlineLink> is your home screen. It provides a quick overview of the entire system:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>KPI Cards</strong> &mdash; counts for Clients, Stores, Products, Reps, and Warehouses (click to navigate).</li>
            <li><strong>Aged Stock Summary</strong> &mdash; a grid showing total quantity and value per client across all warehouses.</li>
            <li><strong>Warehouse Stock Summary</strong> &mdash; total receipted stock currently sitting in warehouses.</li>
            <li><strong>Client filter</strong> &mdash; select/deselect individual clients to focus the view.</li>
            <li><strong>Export to Excel</strong> &mdash; download the aged stock summary as a spreadsheet.</li>
          </ul>
          <GuideScreenshot caption="Dashboard overview showing KPI cards, aged stock grid, and warehouse summary" src="/guide/dashboard.png" />
        </>
      ),
    },
    {
      id: 'control-centre',
      title: '3. Control Centre',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/control-centre">Control Centre</InlineLink> is where master data is maintained.
            Each section is accessible from the sidebar under &quot;Control Centre&quot;:
          </p>
          <GuideScreenshot caption="Control Centre overview with section cards" src="/guide/control-centre.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Clients / Suppliers</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            <InlineLink href="/control-centre/clients">Clients</InlineLink> represent the vendors/suppliers whose
            aged stock is managed. Each client has a name, one or more vendor numbers, and optional SharePoint integration
            links for product data.
          </p>
          <GuideScreenshot caption="Clients list with vendor numbers and type badges" src="/guide/clients.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Stores</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            <InlineLink href="/control-centre/stores">Stores</InlineLink> hold the retail locations where aged stock
            originates. You can import stores in bulk via Excel upload.
          </p>
          <GuideScreenshot caption="Stores list with site codes, channels, managers, and warehouse assignments" src="/guide/stores.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Products</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            <InlineLink href="/control-centre/products">Products</InlineLink> are synced from SharePoint product
            control files linked to each client. Use the &quot;Refresh&quot; button to pull the latest data.
            Products include article codes, barcodes, and vendor product codes.
          </p>
          <GuideScreenshot caption="Products page with client selector and SharePoint refresh" src="/guide/products.png" />

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Reps</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            <InlineLink href="/control-centre/reps">Reps</InlineLink> are field representatives who load aged stock data.
          </p>

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Warehouses</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            <InlineLink href="/control-centre/warehouses">Warehouses</InlineLink> are physical locations where returned
            stock is received and stored. Each warehouse has a unique code used in sticker barcodes.
          </p>
          <GuideScreenshot caption="Warehouses list showing codes, names, and regions" src="/guide/warehouses.png" />
        </>
      ),
    },
    {
      id: 'aged-stock-loading',
      title: '4. Aged Stock — Loading',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            Use the <InlineLink href="/aged-stock/load">Load Aged Stock</InlineLink> page to upload aged stock files:
          </p>
          <ol className="list-decimal list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>Upload</strong> &mdash; drag-and-drop or select an Excel file. The system auto-detects the format (Genkem A/B, SafeTop, USABCO).</li>
            <li><strong>Period selection</strong> &mdash; choose one or more aging periods from the file (e.g. 30, 60, 90, 120+ days).</li>
            <li><strong>Preview</strong> &mdash; review the parsed rows before committing.</li>
            <li><strong>Commit</strong> &mdash; finalise the load. Barcodes and vendor product codes are auto-resolved from the SP product control file.</li>
          </ol>
          <p className="text-sm text-gray-600 leading-relaxed mt-3">
            Each load is dated and append-only &mdash; new uploads never overwrite previous data.
          </p>
          <GuideScreenshot caption="Load Aged Stock page with client picker and file upload" src="/guide/load-aged-stock.png" />
        </>
      ),
    },
    {
      id: 'aged-stock-dashboard',
      title: '5. Aged Stock — Dashboard',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/aged-stock">Aged Stock Dashboard</InlineLink> displays all committed stock data in a
            filterable, sortable grid:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>Filters</strong> &mdash; client, store, article code, barcode, vendor product code, and load.</li>
            <li><strong>Columns</strong> &mdash; site code, site name, article, description, barcode, vendor code, quantity, and value.</li>
            <li><strong>Export to Excel</strong> &mdash; download the filtered view as a spreadsheet.</li>
            <li><strong>Generate Pick Slips</strong> &mdash; select a load and generate pick slips for collection (see next section).</li>
          </ul>
          <GuideScreenshot caption="Aged stock grid with filters, data columns, and export button" src="/guide/aged-stock.png" />
        </>
      ),
    },
    {
      id: 'picking-slips',
      title: '6. Picking Slips',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            Picking slips are generated from the Aged Stock dashboard and managed on the
            <InlineLink href="/aged-stock/picking-slips"> Picking Slips</InlineLink> page.
          </p>

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Generation</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            From the Aged Stock dashboard, click &quot;Generate Pick Slips&quot; on a load. The system creates PDF
            pick slips (one per store) and uploads them to SharePoint. A duplicate guard prevents the same
            load from being generated twice.
          </p>

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Management</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            The management page lets you:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>View</strong> &mdash; see all pick slips with 6 filters (Client, Channel, Store, Ref, Vendor #, Status).</li>
            <li><strong>Edit</strong> &mdash; update quantities or add notes before sending.</li>
            <li><strong>Send</strong> &mdash; email pick slips to stores via Resend.</li>
            <li><strong>Delete</strong> &mdash; remove pick slips that are no longer needed.</li>
            <li><strong>Bulk actions</strong> &mdash; select multiple slips and send or delete in one go.</li>
          </ul>

          <h3 className="text-base font-semibold text-gray-800 mt-4 mb-2">Status Lifecycle</h3>
          <p className="text-sm text-gray-600 leading-relaxed">
            Each pick slip progresses through: <strong>Generated</strong> &rarr; <strong>Sent</strong> &rarr; <strong>Picked</strong> &rarr; <strong>Receipted</strong>.
          </p>
          <GuideScreenshot caption="Picking slips management page with filters, bulk actions, and status badges" src="/guide/picking-slips.png" />
        </>
      ),
    },
    {
      id: 'sticker-labels',
      title: '7. Sticker Labels',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/aged-stock/stickers">Sticker Labels</InlineLink> page lets you create batches
            of barcode sticker labels for warehouse stock:
          </p>
          <ol className="list-decimal list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>Create Batch</strong> &mdash; specify the warehouse and number of stickers needed.</li>
            <li><strong>Download PDF</strong> &mdash; a print-ready A4 PDF is generated with 6 stickers per page.</li>
            <li><strong>Sticker format</strong> &mdash; each sticker has the iRam logo, a Code128 barcode (e.g. <code className="bg-gray-100 px-1 rounded text-xs">STK-JHB-20260420-0001</code>), and 7 ruled fields for manual entry.</li>
          </ol>
          <p className="text-sm text-gray-600 leading-relaxed mt-3">
            Print the PDF and affix stickers to returned stock arriving at the warehouse. The barcode is scanned
            during the receipting process (see next section).
          </p>
          <GuideScreenshot caption="Sticker labels page with batch history and generate form" src="/guide/stickers.png" />
        </>
      ),
    },
    {
      id: 'receiving-stock',
      title: '8. Receive/Release Stock',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/aged-stock/receipts">Receive/Release Stock</InlineLink> page is used by warehouse staff
            to receipt incoming stock and release it for return:
          </p>
          <p className="text-sm text-gray-600 leading-relaxed font-semibold mt-3">Receiving:</p>
          <ol className="list-decimal list-inside text-sm text-gray-600 mt-1 space-y-1">
            <li><strong>Scan barcode</strong> &mdash; use a barcode scanner or enter the sticker code manually.</li>
            <li><strong>Warehouse mismatch warning</strong> &mdash; if the barcode belongs to a different warehouse, a warning is displayed.</li>
            <li><strong>Capture details</strong> &mdash; record value, total boxes, uplifted by, and store references.</li>
            <li><strong>Submit receipt</strong> &mdash; the stock is marked as receipted and the pick slip status updates automatically.</li>
          </ol>
          <p className="text-sm text-gray-600 leading-relaxed font-semibold mt-3">Releasing:</p>
          <ol className="list-decimal list-inside text-sm text-gray-600 mt-1 space-y-1">
            <li><strong>Select rep/user</strong> &mdash; only users with a release code configured are shown.</li>
            <li><strong>Scan barcodes</strong> &mdash; each barcode must match one that was receipted. Mismatches are rejected.</li>
            <li><strong>Box count check</strong> &mdash; all boxes must be released. A partial release requires an RVL Manager override.</li>
            <li><strong>Enter release code</strong> &mdash; the code must match the selected rep/user&apos;s stored code.</li>
          </ol>
          <GuideScreenshot caption="Receive/Release Stock page with pick slip list and capture actions" src="/guide/receive-stock.png" />
        </>
      ),
    },
    {
      id: 'admin-users',
      title: '9. Admin — User Management',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/admin/users">User Management</InlineLink> page (admin only) allows you to:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>Add users</strong> &mdash; create new accounts with name, email, and initial password.</li>
            <li><strong>Assign roles</strong> &mdash; each user is assigned a role (e.g. Super Admin, RVL Manager, Rep, Customer) that determines their permissions.</li>
            <li><strong>Client assignments</strong> &mdash; non-customer users can be assigned to specific clients, scoping what data they see.</li>
            <li><strong>Reset passwords</strong> &mdash; force a password change on next login.</li>
          </ul>
          <GuideScreenshot caption="User management with add form, role selector, and client assignments" src="/guide/user-management.png" />
        </>
      ),
    },
    {
      id: 'admin-roles',
      title: '10. Admin — Roles & Permissions',
      content: (
        <>
          <p className="text-sm text-gray-600 leading-relaxed">
            The <InlineLink href="/admin/roles">Roles &amp; Permissions</InlineLink> page (admin only) lets you define
            what each role can do:
          </p>
          <ul className="list-disc list-inside text-sm text-gray-600 mt-2 space-y-1">
            <li><strong>Roles</strong> &mdash; create or edit roles. System roles (Super Admin, etc.) cannot be deleted.</li>
            <li><strong>Permission keys</strong> &mdash; toggle individual permissions on/off for each role (e.g. <code className="bg-gray-100 px-1 rounded text-xs">view_aged_stock</code>, <code className="bg-gray-100 px-1 rounded text-xs">manage_clients</code>).</li>
            <li><strong>Custom roles</strong> &mdash; create specialised roles for external users or contractors with limited access.</li>
          </ul>
          <GuideScreenshot caption="Roles and permissions page with role list and type badges" src="/guide/roles.png" />
        </>
      ),
    },
  ];
}

/* ---------- main page ---------- */
export default function GuidePage() {
  const { session, loading, logout } = useAuth('view_dashboard');
  const [tocOpen, setTocOpen] = useState(false);

  if (loading || !session) return null;

  const sections = buildSections();

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} onLogout={logout} />

      <main className="ml-64 px-8 py-8 flex flex-col gap-6">
        {/* Header */}
        <div className="bg-white rounded-xl shadow-sm border-l-4 border-[var(--color-primary)] px-6 py-5">
          <h1 className="text-xl font-bold text-gray-900">User Guide</h1>
          <p className="text-sm text-gray-500 mt-1">A walkthrough of iRamFlow from login to daily operations.</p>
        </div>

        <div className="flex gap-6 items-start">
          {/* ---- Sticky sidebar TOC (desktop) ---- */}
          <nav className="hidden lg:block w-64 flex-shrink-0 sticky top-8">
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Contents</h2>
              <ul className="flex flex-col gap-1">
                {sections.map(s => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className="block text-sm text-gray-600 hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-lighter)] px-3 py-1.5 rounded-md transition-colors"
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          {/* ---- Mobile TOC toggle ---- */}
          <div className="lg:hidden w-full">
            <button
              onClick={() => setTocOpen(v => !v)}
              className="w-full bg-white rounded-xl shadow-sm border border-gray-100 px-4 py-3 flex items-center justify-between text-sm font-medium text-gray-700"
            >
              Contents
              <svg className={`w-4 h-4 transition-transform ${tocOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {tocOpen && (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mt-2">
                <ul className="flex flex-col gap-1">
                  {sections.map(s => (
                    <li key={s.id}>
                      <a
                        href={`#${s.id}`}
                        onClick={() => setTocOpen(false)}
                        className="block text-sm text-gray-600 hover:text-[var(--color-primary)] px-3 py-1.5 rounded-md transition-colors"
                      >
                        {s.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* ---- Content ---- */}
          <div className="flex-1 min-w-0 flex flex-col gap-6 lg:max-w-3xl">
            {sections.map(s => (
              <section
                key={s.id}
                id={s.id}
                className="bg-white rounded-xl shadow-sm border border-gray-100 px-6 py-6 scroll-mt-8"
              >
                <h2 className="text-lg font-bold text-gray-900 mb-3">{s.title}</h2>
                {s.content}
              </section>
            ))}

            {/* Footer note */}
            <div className="text-center text-xs text-gray-400 py-4">
              Need help? Contact your administrator or email <a href="mailto:carl@outerjoin.co.za" className="text-[var(--color-primary)] hover:underline">carl@outerjoin.co.za</a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
