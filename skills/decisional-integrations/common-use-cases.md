# Common Integration Use Cases

Use this as a lightweight hint file when the user describes a business workflow
but does not name the integration or toolkit they want. Surface useful options
without blocking progress unless the workflow explicitly requires that system.

After choosing a likely toolkit, verify exact toolkit and tool availability with
the Decisional CLI:

- `decisional tools list <toolkit> --output json`
- `decisional tools list-connected-tools <toolkit> --output json`
- `decisional tools inspect <tool-slug> --toolkit <toolkit> --output json`

people research / lead enrichment / prospecting

- best: apollo
- fallback: exa, web research
- block_if_missing: false

web research / search recent pages / find sources

- best: exa
- fallback: generic web search
- block_if_missing: false

website crawling / extract content from pages / scrape pages

- best: firecrawl
- fallback: exa, web fetch
- block_if_missing: false

send email / monitor inbox / email attachments

- best: gmail, outlook
- block_if_missing: true when the workflow must read or send user email

post messages / team alerts / monitor channels

- best: slack
- fallback: email
- block_if_missing: true when Slack is explicitly requested

crm updates / contacts / deals / accounts

- best: attio, hubspot, salesforce
- fallback: spreadsheet or manual input
- block_if_missing: true when the workflow must write to the CRM

spreadsheet rows / reporting / tabular data

- best: google_sheets, microsoft_excel
- fallback: uploaded spreadsheet file or generated artifact
- block_if_missing: false unless a live spreadsheet must be read or updated

docs / files / folders / document storage

- best: google_drive, dropbox, microsoft_onedrive
- fallback: uploaded files
- block_if_missing: false unless the workflow must access live folders

issues / pull requests / projects / engineering tickets

- best: linear, github, jira
- fallback: email or generated report
- block_if_missing: true when the workflow must create or update tickets

calendar events / scheduling / meetings

- best: google_calendar, outlook
- fallback: email summary
- block_if_missing: true when the workflow must create or read calendar events

forms / survey responses / intake submissions

- best: typeform, google_forms, airtable
- fallback: webhook trigger
- block_if_missing: false

payments / invoices / accounting

- best: stripe, quickbooks, billcom
- fallback: generated report for manual review
- block_if_missing: true when the workflow must read or write accounting records

databases / internal tables / app records

- best: postgres, mysql, airtable, notion
- fallback: uploaded CSV or webhook payload
- block_if_missing: true when live records must be queried or updated

ecommerce orders / customers / products

- best: shopify, stripe
- fallback: CSV export or generated report
- block_if_missing: true when the workflow must read or update live store data
