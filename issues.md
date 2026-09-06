# Fix 1
All backoffice buttons or similar type of buttons use the same css class selector, htps://fonts.google.com/icons (use google fonts icons svg or maybe another fonts library's svg rather than building your own svg icon).

https://backoffice.vesopaepos.com/reports/financial-summary - select (PDF, CSV, XLS) button not properly matched the height with other buttons i.e. run report, view pdf and download buttons. https://backoffice.vesopaepos.com/sales-explorer here also the select option is not aligned with the button height.

https://backoffice.vesopaepos.com/reports/schedules, https://backoffice.vesopaepos.com/timesheets - here x scrollbar is too big, scrollbar customise and small better vesopa branded color scrollbar in desktop view.

https://backoffice.vesopaepos.com/products - icon buttons, edit, duplicate and delete button. https://backoffice.vesopaepos.com/program-groups, https://backoffice.vesopaepos.com/program-departments - icon buttons - edit, delete.  https://backoffice.vesopaepos.com/modifiers - Edit answers button keep or modify with perfect icon, edit and delete icon buttons must, https://backoffice.vesopaepos.com/finalise-keys, https://backoffice.vesopaepos.com/tax, https://backoffice.vesopaepos.com/error-reasons, https://backoffice.vesopaepos.com/mix-match - edit, delete icon buttons, https://backoffice.vesopaepos.com/users delete icon button, https://backoffice.vesopaepos.com/user-roles - edit, delete icon buttons, https://backoffice.vesopaepos.com/staff - edit, delete icon buttons, printer icon not any good - use(C:\Users\Administrator\develop\Vesopa-Ltd\print_24dp_1F1F1F_FILL0_wght400_GRAD0_opsz24.svg), https://backoffice.vesopaepos.com/promotions, https://backoffice.vesopaepos.com/vouchers, https://backoffice.vesopaepos.com/customers - printer icon change, edit, delete button icons. https://backoffice.vesopaepos.com/gift-cards - topup, history, void icon, https://backoffice.vesopaepos.com/deposits printer icon change, edit icon, https://backoffice.vesopaepos.com/rules edit, delete icon buttons, 

https://backoffice.vesopaepos.com/idle-screen - in desktop mode the sections are not aligned properly use flex if you need but fix the sections after another section. 

https://backoffice.vesopaepos.com/kitchen-screens - here upload logo, remove button are not as same height as save brandind, revent button, (Kitchen logins: edit, delete replace with icon buttons)


https://backoffice.vesopaepos.com/import - Choose file design that inputfield differently rather than the current system and after the file is picked then also show that filename with extension as well.

https://backoffice.vesopaepos.com/stock - click an item to refill the stock from here as well. Stock feature is not working properly, order completed, stock should decease. Why not deceasing ?

https://backoffice.vesopaepos.com/screen-programming, https://backoffice.vesopaepos.com/screen-programming?popup=1&screen=1 - here also each buttons, select option, different height and not matching the style. Not professional at all. Align and match the buttons as well.

https://backoffice.vesopaepos.com/tables - visual editors like the https://backoffice.vesopaepos.com/dine-in/table-codes also work on the EPOS app for this as well, different different default shapes adding drag and drop (presents) for table, floor plan making with path builder like photosop polygonal lasso tool and floor color choose, table color choose, once table added it automatically added to the QR menu and QR is generated as well once added. Visual best editor needed here.

https://backoffice.vesopaepos.com/receipt-designer - receipt designer is good but can we use visual editor here as well like two options manual and visual and user choose which one to pick and which one to select and finalize. (not necessary now)






the mobile navbar is a big issue in back office -  <img src="/assets/vesopa_logo.png?v=012a73375b" alt="Vesopa" class="topbar-logo lockup-light"> wrap day or light img <div style="display:block; text-align:center;"><img></div.> .lockup-light { display: flex;  align-items: center; justify-content: center; max-width: 147px; width: 100%; text-align: center; height: auto;} or maybe {display: inline-flex, width: 100%, max-width: 147px} would fix the issue centering the brand logo and also navbar hamburger icon for menu is not shown there and also navbar is not expanded and blank white screen. Fix that as well. Desktop menu hidden with a hamburger icon but extra padding left but I want to match the both side padding once hidden the sidebar to match the view.



Chrome Console Log Shwoing:
contentscript.js:14083 MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 close listeners added. Use emitter.setMaxListeners() to increase limit
contentscript.js:14083 MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 end listeners added. Use emitter.setMaxListeners() to increase limit
contentscript.js:14083 ObjectMultiplex - orphaned data for stream "app-init-liveness"
contentscript.js:14083 ObjectMultiplex - orphaned data for stream "app-init-liveness"
contentscript.js:14083 ObjectMultiplex - orphaned data for stream "background-liveness"
contentscript.js:14083 ObjectMultiplex - orphaned data for stream "background-liveness"

THese are simple but necesary fixes. Fix quickly and deploy. No need to build any store release for now. Would do that later but fix the till.


Every long page or infinity scroll page loads with the page scroll like https://backoffice.vesopaepos.com/sales-explorer - load few and on scroll to the bottom loads and loads but do it silently behind the screen so that client never saves loading issues.




# Fix 2


https://backoffice.vesopaepos.com/reports/financial-summary button size fixed, but buttons are not aligned with each other means not in the same line now. Fix it.


https://backoffice.vesopaepos.com/sales-explorer search button is not aligned with the From - To - Department input fields. Match it.
https://backoffice.vesopaepos.com/products Clear button is not aligned with input fields to it's left.

https://backoffice.vesopaepos.com/sales-explorer, https://backoffice.vesopaepos.com/bill-report why loading 100+ products, load 100 first, before it ends load another 100 before scroll ends and again loads another and like that finishes as goes.

https://backoffice.vesopaepos.com/screen-programming?popup=1 after bottom bars there is a select picker input which has extensive height, fix that height maintaining the right adjacent buttons. Top bar, bottom bar select picker also fix their height maintaining the buttons on adjacents.

https://backoffice.vesopaepos.com/dine-in - Collapsible options and preview at the right side until the screen is too low. Picture URL (optional) why url - no url, interactive image picker which we already have in our system. All the image and logo must not set url, set the image picker and preview beside. Why you set the domain qr.vesopaepos.com/(ktichenurl) it's wrong. menu.vesopaepos.com/(ktichenurl) was right. menu.vesopaepos.com/(ktichenurl) this will be our main url to offer whereas users can pick their own domain. Can skip that now. But set menu.vesopa.com for now on. Your colours should show my color in circle box and picker and change to preview and save to permanantly added.

https://backoffice.vesopaepos.com/dine-in/menu collapsible each sections. Section then line underneath it's below. Two fields, input hint inside or inline text than goes to the top left side of the inpur field like material input, buttons after the input save and delete too much width, not friendly. Redesign needed of this page. Suggestions given. Don't have to show the PLU 144


