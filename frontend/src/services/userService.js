import apiClient from "./apiClient";

export const userService = {
  get:    () => apiClient.get("/users").then(r => r.data.data),
  update: (payload) => apiClient.put("/users", payload).then(r => r.data.data),
  changePassword: (payload) => apiClient.patch("/users/change-password", payload).then(r => r.data.data),
  uploadAvatar: (file) => {
    const f = new FormData(); f.append("avatar", file);
    return apiClient.post("/users/avatar", f, { headers: { "Content-Type": "multipart/form-data" } })
      .then(r => r.data.data);
  },
  // Recently viewed
  getRecentlyViewed: ()           => apiClient.get("/users/recently-viewed").then(r => r.data.data.recently_viewed),
  addRecentlyViewed: (product_id) => apiClient.post("/users/recently-viewed", { product_id }).then(r => r.data.data),

  // Wishlist
  getWishlist:       ()          => apiClient.get("/users/wishlist").then(r => r.data.data.wishlist),
  addToWishlist:     (product_id) => apiClient.post("/users/wishlist", { product_id }).then(r => r.data.data),
  removeFromWishlist:(product_id) => apiClient.delete(`/users/wishlist/${product_id}`).then(r => r.data.data),
};
