GasHub Admin Dealers page fix

1. Copy admin/admin-dealers.html into your existing project, replacing the current admin/admin-dealers.html.
2. Sign out of the admin page, then sign back in using the admin login page.
3. Reload the Dealers page and test loading/saving dealers.

Why:
- Escapes the hyphen in the HTML username pattern for browsers that validate patterns using Unicode v-mode.
- The 401 error means the server rejected the stored admin session. Since admin sessions are held in server memory, a backend restart can invalidate them. Sign in again after the server is running. Do not disable the authentication check.


