// Sortings Functions
function compareStringsAsc(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  return (a < b) ? -1 : (a > b) ? 1 : 0;
}

function compareStringsDesc(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  return (b < a) ? -1 : (b > a) ? 1 : 0;
}

function compareNumberAsc(a, b) {
	return parseFloat(a) - parseFloat(b);
}

function compareNumberDesc(a, b) {
	return parseFloat(b) - parseFloat(a);
}





/* Back Button Configuration */
function goBack () {
    history.back()
}





// Full screen modal initialization
function open_mobile_full_screen_modal ( topbarHTML, bodyHTML = "") {
    
    const modal_mainbox = document.getElementById("all_container_modal");
    const modal_inside = document.getElementById("all_container_modal_inside");
    const modal_topbar = document.getElementById("all_container_modal_topbar");
    
    modal_topbar.innerHTML = topbarHTML;
    modal_inside.innerHTML = bodyHTML;
    modal_mainbox.style.display = "block";
    
}


function close_mobile_full_screen_modal () {
    document.getElementById("all_container_modal").style.display = "none";
}







// Alert box modal initialization
const alert_box_window = document.getElementById("alert_box_window");
const alert_box_inside = document.getElementById("alert_box_inside");

const closeTheModal = () => { alert_box_window.style.display = "none"; };


window.onclick = function(event) {
  if (event.target == alert_box_window) {
    closeTheModal();
  }
}

const show_universal_modal = ( modalWidth, modalHeight, modalHTML) => {
	alert_box_inside.style.width = modalWidth;
	alert_box_inside.style.height = modalHeight;
	
	alert_box_inside.innerHTML = modalHTML;
    
    alert_box_window.style.display = "block";
}










